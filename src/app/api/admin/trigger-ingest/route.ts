import "server-only";
import { type NextRequest } from "next/server";
import { supabaseAdmin } from "~/lib/supabase-admin";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { issueId: string };

  if (!body.issueId) {
    return Response.json({ error: "missing issueId" }, { status: 400 });
  }

  const { data: issue } = (await supabaseAdmin
    .from("issues")
    .select("id, pipeline_step")
    .eq("id", body.issueId)
    .single()) as {
    data: { id: string; pipeline_step: string | null } | null;
  };

  if (!issue) {
    return Response.json({ error: "issue not found" }, { status: 404 });
  }

  const { error } = await supabaseAdmin
    .from("issues")
    .update({
      pipeline_step: "queued",
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    })
    .eq("id", body.issueId);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true, issueId: body.issueId, status: "queued" });
}
