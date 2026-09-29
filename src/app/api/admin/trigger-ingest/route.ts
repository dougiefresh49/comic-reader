import "server-only";
import { type NextRequest } from "next/server";
import { getHookByToken, start } from "workflow/api";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { ingestPipeline } from "~/workflows/ingest-pipeline";
import { selectIssue, updateIssue } from "~/lib/issue-queries";
import { ingestHookToken } from "~/app/api/admin/cancel-ingest/hooks";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    bookId: string;
    issueId: string;
    fromStep?: string;
  };

  if (!body.bookId || !body.issueId) {
    return Response.json(
      { error: "missing bookId or issueId" },
      { status: 400 },
    );
  }

  const { data: issue } = (await selectIssue(
    supabaseAdmin,
    body.bookId,
    body.issueId,
    "id, pipeline_step, pipeline_paused, pipeline_paused_at",
  ).single()) as {
    data: {
      id: string;
      pipeline_step: string | null;
      pipeline_paused: boolean | null;
      pipeline_paused_at: string | null;
    } | null;
  };

  if (!issue) {
    return Response.json({ error: "issue not found" }, { status: 404 });
  }

  // A paused run holds its gate's hook token (`ingestHookToken`), and every
  // run of this issue uses the same tokens, so a second run fails at that
  // gate with HookConflictError (#208). Refuse before writing or starting.
  const { data: openRuns, error: openRunsError } = (await supabaseAdmin
    .from("pipeline_runs")
    .select("steps")
    .eq("book_id", body.bookId)
    .eq("issue_id", body.issueId)
    .eq("status", "running")
    .order("started_at", { ascending: false })) as {
    data: Array<{ steps: { runId?: string } | null }> | null;
    error: { message: string } | null;
  };

  if (openRunsError) {
    return Response.json({ error: openRunsError.message }, { status: 500 });
  }

  if (issue.pipeline_paused || (openRuns?.length ?? 0) > 0) {
    const pausedAt = issue.pipeline_paused
      ? (issue.pipeline_paused_at ?? issue.pipeline_step ?? "an unknown step")
      : null;
    let runId = openRuns?.[0]?.steps?.runId ?? null;
    if (issue.pipeline_paused && issue.pipeline_paused_at) {
      try {
        const hook = await getHookByToken(
          ingestHookToken(body.bookId, body.issueId, issue.pipeline_paused_at),
        );
        runId = hook.runId;
      } catch {
        // No hook for this pause: keep the pipeline_runs run id.
      }
    }
    const state = pausedAt
      ? `paused at ${pausedAt}`
      : `running (pipeline_step ${issue.pipeline_step ?? "unknown"})`;
    return Response.json(
      {
        error: `Run ${runId ?? "(run id unknown)"} of ${body.bookId}/${body.issueId} is ${state}. Cancel it first with cancel-ingest, then trigger again. If cancel-ingest answers that the run or its hook is not found, or that the issue is not cancellable, the pause flag or pipeline_runs row is stale and has to be cleared by hand.`,
        runId,
        pausedAt,
        pipelineStep: issue.pipeline_step,
      },
      { status: 409 },
    );
  }

  const pipelineStep = body.fromStep ?? "roboflow-page-analyze";

  const { error } = await updateIssue(
    supabaseAdmin,
    body.bookId,
    body.issueId,
    {
      pipeline_step: pipelineStep,
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    },
  );

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const run = await start(ingestPipeline, [
    {
      bookId: body.bookId,
      issueId: body.issueId,
      fromStep: body.fromStep,
    },
  ]);

  const { error: runError } = await supabaseAdmin.from("pipeline_runs").insert({
    book_id: body.bookId,
    issue_id: body.issueId,
    status: "running",
    steps: {
      runId: run.runId,
      fromStep: body.fromStep ?? null,
      skipped: [],
    },
  });

  if (runError) {
    console.error("pipeline_runs insert failed after start():", runError);
    return Response.json({
      ok: true,
      bookId: body.bookId,
      issueId: body.issueId,
      fromStep: body.fromStep ?? null,
      runId: run.runId,
      status: "started",
      warning: runError.message,
    });
  }

  return Response.json({
    ok: true,
    bookId: body.bookId,
    issueId: body.issueId,
    fromStep: body.fromStep ?? null,
    runId: run.runId,
    status: "started",
  });
}
