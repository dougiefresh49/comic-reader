import "server-only";
import { type NextRequest } from "next/server";
import pLimit from "p-limit";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { storePageImage } from "~/lib/page-images";
import { insertIssue, selectIssue, updateIssue } from "~/lib/issue-queries";
import { countIssuePages } from "~/lib/add-content/issue-pages";

export const maxDuration = 300;

const RAW_BUCKET = "comic-pages-raw";

/**
 * Whether an issue may take pages from disk, and the `pages` rows it holds.
 * It may when it holds none (by `page_count` and by rows), or when it is an
 * unfinished disk store: rows stored, but the last finalize batch never wrote
 * `page_count` or `pipeline_step`. Disk `init` sets `source_pages_path`; an
 * online download sets it only when it ends, with `pipeline_step`, so a
 * download that stopped part way is never taken for one. Null when the issue
 * row is gone.
 */
async function pagesHeld(
  bookId: string,
  issueId: string,
): Promise<{ rows: number; takesPages: boolean } | null> {
  const { data: row, error } = await selectIssue(
    supabaseAdmin,
    bookId,
    issueId,
    "page_count, pipeline_step, source_pages_path",
  ).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return null;
  const rows = await countIssuePages(bookId, issueId);
  const empty = !row.page_count && rows === 0;
  const unfinishedDiskStore =
    !row.page_count &&
    row.pipeline_step === null &&
    !!row.source_pages_path &&
    rows > 0;
  return { rows, takesPages: empty || unfinishedDiskStore };
}

/** The first page number from 1 up with no `pages` row. */
async function firstMissingPage(
  bookId: string,
  issueId: string,
): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("pages")
    .select("number")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { number: number }[];
  const numbers = new Set(rows.map((p) => p.number));
  let page = 1;
  while (numbers.has(page)) page++;
  return page;
}

const hasPagesError = (bookId: string, issueId: string) =>
  Response.json(
    {
      error: `${issueId} already has pages in ${bookId}. Pages from disk fill an issue that has none.`,
    },
    { status: 409 },
  );

interface CreateUrlBody {
  bookId: string;
  issueId: string;
  filename: string;
}

interface InitIssueBody {
  bookId: string;
  issueId: string;
  issueName?: string;
  number: number;
}

interface FinalizeBody {
  bookId: string;
  issueId: string;
  /** Pages 1..count are the issue; any other raw file is a leftover. */
  count: number;
  /** The pages this request stores, inclusive: one batch of 1..count. */
  from: number;
  to: number;
}

// POST: { mode: "init" | "url" | "finalize" } + payload
// init      → takes an issue with no pages, or an unfinished disk store:
//             creates the issues row, or keeps the one the Add content flow
//             saved, and returns `resumeFrom`; 409 if the issue has pages
// url       → returns signed upload URL for one file
// finalize  → convert raw pages from..to to WebP and upsert their pages rows;
//             the batch ending at count sets page_count and pipeline_step
export async function POST(req: NextRequest) {
  const body = (await req.json()) as
    | ({ mode: "url" } & CreateUrlBody)
    | ({ mode: "init" } & InitIssueBody)
    | ({ mode: "finalize" } & FinalizeBody);

  if (body.mode === "init") {
    if (!body.bookId || !body.issueId || !body.number) {
      return Response.json({ error: "missing fields" }, { status: 400 });
    }
    // Refuse before any write, so a refused init leaves the DB untouched.
    const { data: book, error: bookErr } = await supabaseAdmin
      .from("books")
      .select("id")
      .eq("id", body.bookId)
      .maybeSingle();
    if (bookErr) {
      return Response.json({ error: bookErr.message }, { status: 500 });
    }
    if (!book) {
      return Response.json(
        { error: `No book ${body.bookId}. Save the book first.` },
        { status: 404 },
      );
    }
    const { data: existing, error: lookupErr } = await selectIssue(
      supabaseAdmin,
      body.bookId,
      body.issueId,
      "id, page_count",
    ).maybeSingle();
    if (lookupErr) {
      return Response.json({ error: lookupErr.message }, { status: 500 });
    }
    const sourcePath = `${body.bookId}/${body.issueId}/source/`;
    if (existing) {
      // An issue saved with no pages yet takes them here (#793), and so does
      // an unfinished disk store (#821), from its first missing page. One
      // that has pages any other way is refused.
      let resumeFrom = 1;
      try {
        const held = await pagesHeld(body.bookId, body.issueId);
        if (held && !held.takesPages) {
          return hasPagesError(body.bookId, body.issueId);
        }
        if (held && held.rows > 0) {
          resumeFrom = await firstMissingPage(body.bookId, body.issueId);
        }
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: 500 },
        );
      }
      const { error: updateErr } = await updateIssue(
        supabaseAdmin,
        body.bookId,
        body.issueId,
        { source_pages_path: sourcePath },
      );
      if (updateErr) {
        return Response.json({ error: updateErr.message }, { status: 500 });
      }
      return Response.json({ ok: true, sourcePath, resumeFrom });
    }
    // insert, not upsert: a racing init that lost the check above hits the
    // primary key (23505) instead of overwriting the row.
    const { error: issueErr } = await insertIssue(supabaseAdmin, {
      id: body.issueId,
      book_id: body.bookId,
      number: body.number,
      name: body.issueName ?? `Issue ${body.number}`,
      status: "pending",
      source_pages_path: sourcePath,
    });
    if (issueErr) {
      if (issueErr.code === "23505") {
        return Response.json(
          {
            error: `${body.issueId} was just created in ${body.bookId}; try again.`,
          },
          { status: 409 },
        );
      }
      return Response.json({ error: issueErr.message }, { status: 500 });
    }
    return Response.json({ ok: true, sourcePath, resumeFrom: 1 });
  }

  if (body.mode === "url") {
    if (!body.bookId || !body.issueId || !body.filename) {
      return Response.json({ error: "missing fields" }, { status: 400 });
    }
    const safeName = body.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${body.bookId}/${body.issueId}/source/${safeName}`;

    // Storage v2 signed URLs are valid for 60 seconds and allow PUT.
    const { data, error } = await supabaseAdmin.storage
      .from(RAW_BUCKET)
      .createSignedUploadUrl(path, { upsert: true });
    if (error || !data) {
      return Response.json(
        { error: error?.message ?? "failed to create signed url" },
        { status: 500 },
      );
    }
    return Response.json({
      uploadUrl: data.signedUrl,
      token: data.token,
      path,
    });
  }

  if (body.mode === "finalize") {
    if (
      !body.bookId ||
      !body.issueId ||
      !Number.isInteger(body.count) ||
      !Number.isInteger(body.from) ||
      !Number.isInteger(body.to) ||
      body.from < 1 ||
      body.from > body.to ||
      body.to > body.count
    ) {
      return Response.json({ error: "missing fields" }, { status: 400 });
    }

    // The same refusal as init, before the first write: another writer may
    // have stored pages since init ran. A batch past the first also needs
    // every page before it stored; rows from `from` on are this same store's
    // and the upsert overwrites them.
    let held: { rows: number; takesPages: boolean } | null;
    let firstMissing = 1;
    try {
      held = await pagesHeld(body.bookId, body.issueId);
      if (held?.takesPages && body.from > 1) {
        firstMissing = await firstMissingPage(body.bookId, body.issueId);
      }
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
    if (!held) {
      return Response.json(
        { error: `No issue ${body.issueId} in ${body.bookId}.` },
        { status: 404 },
      );
    }
    if (!held.takesPages) return hasPagesError(body.bookId, body.issueId);
    if (body.from > 1 && firstMissing < body.from) {
      return Response.json(
        {
          error: `Page ${firstMissing} of ${body.issueId} is not stored, so pages ${body.from}–${body.to} cannot follow it.`,
        },
        { status: 409 },
      );
    }

    const prefix = `${body.bookId}/${body.issueId}/source`;
    const listLimit = 1000;
    const files: { name: string; updated_at?: string | null }[] = [];
    for (let offset = 0; ; offset += listLimit) {
      const { data: page, error: listError } = await supabaseAdmin.storage
        .from(RAW_BUCKET)
        .list(prefix, { limit: listLimit, offset });
      if (listError) {
        return Response.json({ error: listError.message }, { status: 500 });
      }
      const batch = page ?? [];
      files.push(...batch);
      if (batch.length < listLimit) break;
    }

    // Pages from..to, the newest file of each: an earlier attempt may have
    // left more pages, or the same page under another extension.
    const newest = new Map<number, { name: string; updated: string }>();
    for (const f of files) {
      const match = /^page-(\d+)\.[a-z0-9]+$/i.exec(f.name);
      if (!match) continue;
      const pageNumber = parseInt(match[1]!, 10);
      if (pageNumber < body.from || pageNumber > body.to) continue;
      const updated = f.updated_at ?? "";
      const seen = newest.get(pageNumber);
      if (!seen || updated > seen.updated) {
        newest.set(pageNumber, { name: f.name, updated });
      }
    }
    const pageFiles: { name: string; pageNumber: number }[] = [];
    for (let pageNumber = body.from; pageNumber <= body.to; pageNumber++) {
      const file = newest.get(pageNumber);
      if (!file) {
        return Response.json(
          { error: `Page ${pageNumber} is missing from ${prefix}/` },
          { status: 400 },
        );
      }
      pageFiles.push({ name: file.name, pageNumber });
    }

    let stored = 0;
    const errors: string[] = [];
    const warnings: string[] = [];
    // Each page now costs a Gemini detect call (#541): three at a time.
    const limit = pLimit(3);

    const storeOne = async (file: { name: string; pageNumber: number }) => {
      const path = `${prefix}/${file.name}`;
      const { data: blob, error: dlError } = await supabaseAdmin.storage
        .from(RAW_BUCKET)
        .download(path);
      if (dlError || !blob) {
        errors.push(
          `page ${file.pageNumber}: download failed (${dlError?.message ?? "no data"})`,
        );
        return;
      }
      try {
        const buffer = Buffer.from(await blob.arrayBuffer());
        const { failures } = await storePageImage({
          bookId: body.bookId,
          issueId: body.issueId,
          pageNumber: file.pageNumber,
          buffer,
        });
        stored++;
        if (failures.length > 0) {
          warnings.push(
            `page ${file.pageNumber}; watermark left: ${failures.map((f) => f.reason).join(", ")}`,
          );
        }
      } catch (err) {
        errors.push(
          `page ${file.pageNumber}: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }
    };

    await Promise.all(pageFiles.map((file) => limit(() => storeOne(file))));

    if (errors.length > 0) {
      // Leave page_count and pipeline_step alone: a count here would turn
      // this store into "already has pages" and lock out the resume (#821).
      // The stored rows alone make the issue read unfinished in the Issue
      // step, and every other guard counts them (`countIssuePages`).
      const resumeFrom = await firstMissingPage(
        body.bookId,
        body.issueId,
      ).catch(() => undefined);
      return Response.json(
        {
          error: `finalize failed for ${errors.length} page(s)`,
          stored,
          total: pageFiles.length,
          errors,
          ...(resumeFrom ? { resumeFrom } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        },
        { status: 500 },
      );
    }

    // Only the batch that ends the issue writes its row, counting every
    // batch's pages.
    if (body.to === body.count) {
      let rows: number;
      try {
        rows = await countIssuePages(body.bookId, body.issueId);
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: 500 },
        );
      }
      const { error: issueErr } = await updateIssue(
        supabaseAdmin,
        body.bookId,
        body.issueId,
        {
          page_count: rows,
          has_webp: true,
          // The same step the confirmed download sets; Start Pipeline reads
          // it as not started (`isUnstartedStep`).
          pipeline_step: "pages-downloaded",
        },
      );
      if (issueErr) {
        return Response.json({ error: issueErr.message }, { status: 500 });
      }
    }

    return Response.json({
      ok: true,
      stored,
      total: pageFiles.length,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  }

  return Response.json({ error: "invalid mode" }, { status: 400 });
}
