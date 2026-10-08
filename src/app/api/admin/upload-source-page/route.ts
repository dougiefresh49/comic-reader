import "server-only";
import { type NextRequest } from "next/server";
import pLimit from "p-limit";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { storePageImage } from "~/lib/page-images";
import { insertIssue, selectIssue, updateIssue } from "~/lib/issue-queries";

export const maxDuration = 300;

const RAW_BUCKET = "comic-pages-raw";

interface CreateUrlBody {
  bookId: string;
  issueId: string;
  filename: string;
}

interface InitIssueBody {
  bookId: string;
  bookName?: string;
  issueId: string;
  issueName?: string;
  number: number;
}

interface FinalizeBody {
  bookId: string;
  issueId: string;
}

// POST: { mode: "init" | "url" | "finalize" } + payload
// init      → creates books row only if missing, creates the issues row; 409 if the issue exists
// url       → returns signed upload URL for one file
// finalize  → convert raw sources to WebP, upsert pages rows, set page_count
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
    const alreadyExists = (status: string | null) =>
      Response.json(
        {
          error: `${body.issueId} already exists in ${body.bookId}${status ? ` (status ${status})` : ""}. This uploader only creates new issues; pick an unused issue number.`,
        },
        { status: 409 },
      );
    const { data: existing, error: lookupErr } = await selectIssue(
      supabaseAdmin,
      body.bookId,
      body.issueId,
      "id, status",
    ).maybeSingle();
    if (lookupErr) {
      return Response.json({ error: lookupErr.message }, { status: 500 });
    }
    if (existing) {
      return alreadyExists(existing.status);
    }
    if (body.bookName) {
      // Existing book is never changed (a racing init cannot overwrite it either).
      const { error: bookErr } = await supabaseAdmin.from("books").upsert(
        {
          id: body.bookId,
          name: body.bookName,
          slug: body.bookId,
        },
        { onConflict: "id", ignoreDuplicates: true },
      );
      if (bookErr) {
        return Response.json({ error: bookErr.message }, { status: 500 });
      }
    }
    const sourcePath = `${body.bookId}/${body.issueId}/source/`;
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
      if (issueErr.code === "23505") return alreadyExists(null);
      return Response.json({ error: issueErr.message }, { status: 500 });
    }
    return Response.json({ ok: true, sourcePath });
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
    if (!body.bookId || !body.issueId) {
      return Response.json({ error: "missing fields" }, { status: 400 });
    }

    const prefix = `${body.bookId}/${body.issueId}/source`;
    const listLimit = 1000;
    const files: { name: string }[] = [];
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

    const pageFiles = files
      .map((f) => {
        const match = /^page-(\d+)\.[a-z0-9]+$/i.exec(f.name);
        if (!match) return null;
        return { name: f.name, pageNumber: parseInt(match[1]!, 10) };
      })
      .filter((f): f is { name: string; pageNumber: number } => f !== null)
      .sort((a, b) => a.pageNumber - b.pageNumber);

    if (pageFiles.length === 0) {
      return Response.json(
        { error: `No source pages found at ${prefix}/` },
        { status: 400 },
      );
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
      return Response.json(
        {
          error: `finalize failed for ${errors.length} page(s)`,
          stored,
          total: pageFiles.length,
          errors,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
        { status: 500 },
      );
    }

    const { error: issueErr } = await updateIssue(
      supabaseAdmin,
      body.bookId,
      body.issueId,
      {
        page_count: stored,
        has_webp: true,
      },
    );

    if (issueErr) {
      return Response.json({ error: issueErr.message }, { status: 500 });
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
