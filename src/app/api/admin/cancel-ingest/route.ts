import "server-only";
import { type NextRequest } from "next/server";
import { getHookByToken, getRun } from "workflow/api";
import { supabaseAdmin } from "~/lib/supabase-admin";

const PAUSE_TO_HOOK_STEP: Record<string, string> = {
  "review-clusters": "cluster-review",
  "review-pages": "page-review",
  "review-new-characters": "character-review",
  casting: "casting",
};

type PipelineRunSteps = {
  runId?: string;
  fromStep?: string | null;
  skipped?: unknown;
};

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    bookId: string;
    issueId: string;
  };

  if (!body.bookId || !body.issueId) {
    return Response.json(
      { error: "missing bookId or issueId" },
      { status: 400 },
    );
  }

  const { data: issue } = (await supabaseAdmin
    .from("issues")
    .select("id, pipeline_step, pipeline_paused, pipeline_paused_at")
    .eq("book_id", body.bookId)
    .eq("id", body.issueId)
    .single()) as {
    data: {
      id: string;
      pipeline_step: string | null;
      pipeline_paused: boolean;
      pipeline_paused_at: string | null;
    } | null;
  };

  if (!issue) {
    return Response.json({ error: "issue not found" }, { status: 404 });
  }

  let runId: string | null = null;

  if (issue.pipeline_paused && issue.pipeline_paused_at) {
    const hookStep =
      PAUSE_TO_HOOK_STEP[issue.pipeline_paused_at] ?? issue.pipeline_paused_at;
    const token = `ingest:${body.bookId}/${body.issueId}/${hookStep}`;
    try {
      const hook = await getHookByToken(token);
      runId = hook.runId;
    } catch {
      return Response.json(
        { error: "Hook not found for this pause" },
        { status: 404 },
      );
    }
  } else {
    const { data: runRow } = (await supabaseAdmin
      .from("pipeline_runs")
      .select("id, steps")
      .eq("book_id", body.bookId)
      .eq("issue_id", body.issueId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()) as {
      data: { id: string; steps: PipelineRunSteps | null } | null;
    };

    runId = runRow?.steps?.runId ?? null;
    if (!runId) {
      return Response.json(
        { error: "No pipeline run found for this issue" },
        { status: 404 },
      );
    }
  }

  try {
    await getRun(runId).cancel();
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : "Failed to cancel run",
      },
      { status: 500 },
    );
  }

  const failedStep =
    issue.pipeline_paused_at ??
    (issue.pipeline_step?.startsWith("failed:")
      ? issue.pipeline_step.replace("failed:", "")
      : issue.pipeline_step) ??
    "error";

  const { error: issueError } = await supabaseAdmin
    .from("issues")
    .update({
      pipeline_step: `failed:${failedStep}`,
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    })
    .eq("book_id", body.bookId)
    .eq("id", body.issueId);

  if (issueError) {
    return Response.json({ error: issueError.message }, { status: 500 });
  }

  const { error: runError } = await supabaseAdmin
    .from("pipeline_runs")
    .update({
      status: "cancelled",
      completed_at: new Date().toISOString(),
    })
    .eq("book_id", body.bookId)
    .eq("issue_id", body.issueId)
    .eq("status", "running");

  if (runError) {
    return Response.json({ error: runError.message }, { status: 500 });
  }

  return Response.json({
    ok: true,
    bookId: body.bookId,
    issueId: body.issueId,
    runId,
    failedStep,
  });
}
