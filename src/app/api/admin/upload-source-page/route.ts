import "server-only";
import { type NextRequest } from "next/server";
import { supabaseAdmin } from "~/lib/supabase-admin";

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

// POST: { mode: "init" | "url" } + payload
// init  → upserts books + issues row
// url   → returns signed upload URL for one file
export async function POST(req: NextRequest) {
  const body = (await req.json()) as
    | ({ mode: "url" } & CreateUrlBody)
    | ({ mode: "init" } & InitIssueBody);

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

  return Response.json({ error: "invalid mode" }, { status: 400 });
}
