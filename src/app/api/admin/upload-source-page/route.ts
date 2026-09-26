import "server-only";
import { type NextRequest } from "next/server";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { storePageImage } from "~/lib/page-images";

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
// init      → upserts books + issues row
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
    if (body.bookName) {
      const { error: bookErr } = await supabaseAdmin.from("books").upsert(
        {
          id: body.bookId,
          name: body.bookName,
          slug: body.bookId,
        },
        { onConflict: "id" },
      );
      if (bookErr) {
        return Response.json({ error: bookErr.message }, { status: 500 });
      }
    }
    const sourcePath = `${body.bookId}/${body.issueId}/source/`;
    const { error: issueErr } = await supabaseAdmin.from("issues").upsert(
      {
        id: body.issueId,
        book_id: body.bookId,
        number: body.number,
        name: body.issueName ?? `Issue ${body.number}`,
        status: "pending",
        source_pages_path: sourcePath,
      },
      { onConflict: "book_id,id" },
    );
    if (issueErr) {
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
    const { data: files, error: listError } = await supabaseAdmin.storage
      .from(RAW_BUCKET)
      .list(prefix);

    if (listError) {
      return Response.json({ error: listError.message }, { status: 500 });
    }

    const pageFiles = (files ?? [])
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

    for (const file of pageFiles) {
      const path = `${prefix}/${file.name}`;
      const { data: blob, error: dlError } = await supabaseAdmin.storage
        .from(RAW_BUCKET)
        .download(path);
      if (dlError || !blob) {
        errors.push(
          `page ${file.pageNumber}: download failed (${dlError?.message ?? "no data"})`,
        );
        continue;
      }
      try {
        const buffer = Buffer.from(await blob.arrayBuffer());
        await storePageImage({
          bookId: body.bookId,
          issueId: body.issueId,
          pageNumber: file.pageNumber,
          buffer,
        });
        stored++;
      } catch (err) {
        errors.push(
          `page ${file.pageNumber}: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }
    }

    if (stored === 0) {
      return Response.json(
        { error: `finalize stored 0 pages`, details: errors },
        { status: 500 },
      );
    }

    const { error: issueErr } = await supabaseAdmin
      .from("issues")
      .update({
        page_count: stored,
        has_webp: true,
      })
      .eq("book_id", body.bookId)
      .eq("id", body.issueId);

    if (issueErr) {
      return Response.json({ error: issueErr.message }, { status: 500 });
    }

    return Response.json({
      ok: true,
      stored,
      total: pageFiles.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  }

  return Response.json({ error: "invalid mode" }, { status: 400 });
}
