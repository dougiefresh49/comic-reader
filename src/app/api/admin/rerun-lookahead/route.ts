import "server-only";
import { type NextRequest } from "next/server";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { characterLookaheadPage } from "~/workflows/steps/vision";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { bookId: string; issueId: string };

  if (!body.bookId || !body.issueId) {
    return Response.json(
      { error: "missing bookId or issueId" },
      { status: 400 },
    );
  }

  const { data: panels } = await supabaseAdmin
    .from("panels")
    .select("page_number")
    .eq("book_id", body.bookId)
    .eq("issue_id", body.issueId);

  if (!panels || panels.length === 0) {
    return Response.json({ error: "no panels found" }, { status: 404 });
  }

  const pageNumbers = [
    ...new Set(panels.map((p) => p.page_number as number)),
  ].sort((a, b) => a - b);

  await supabaseAdmin
    .from("issues")
    .update({ pipeline_step: "character-lookahead", pipeline_paused: false })
    .eq("id", body.issueId);

  const results: Array<{ page: number; status: string; error?: string }> = [];

  for (const pageNumber of pageNumbers) {
    try {
      await characterLookaheadPage(body.bookId, body.issueId, pageNumber);
      results.push({ page: pageNumber, status: "ok" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ page: pageNumber, status: "error", error: msg });
    }
  }

  await supabaseAdmin
    .from("issues")
    .update({
      pipeline_step: "review-clusters",
      pipeline_paused: true,
      pipeline_paused_at: "review-clusters",
    })
    .eq("id", body.issueId);

  return Response.json({ ok: true, pages: results });
}
