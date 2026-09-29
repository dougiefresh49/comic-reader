import "server-only";
import { type NextRequest } from "next/server";
import { getHookByToken, getRun, start } from "workflow/api";
import { HookNotFoundError, WorkflowRunNotFoundError } from "workflow/errors";
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
  // gate with HookConflictError (#208). Refuse only while the old run is
  // live: a pause whose hook is gone, or a row whose run is gone or done, is
  // stale and passes. A lookup that errors (not a clean not-found) refuses.
  const { data: openRuns, error: openRunsError } = (await supabaseAdmin
    .from("pipeline_runs")
    .select("id, steps")
    .eq("book_id", body.bookId)
    .eq("issue_id", body.issueId)
    .eq("status", "running")
    .order("started_at", { ascending: false })) as {
    data: Array<{ id: string; steps: { runId?: string } | null }> | null;
    error: { message: string } | null;
  };

  if (openRunsError) {
    return Response.json({ error: openRunsError.message }, { status: 500 });
  }

  const label = `${body.bookId}/${body.issueId}`;
  const refuse = (runId: string, state: string) =>
    Response.json(
      {
        error: `Run ${runId} of ${label} is ${state}. Cancel it first with cancel-ingest, then trigger again.`,
        runId,
        pausedAt: issue.pipeline_paused ? issue.pipeline_paused_at : null,
        pipelineStep: issue.pipeline_step,
      },
      { status: 409 },
    );
  const checkFailed = (what: string, err: unknown) =>
    Response.json(
      {
        error: `Could not check whether ${what} of ${label} is still live, so nothing was started: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 409 },
    );
  const stale: string[] = [];

  if (issue.pipeline_paused && issue.pipeline_paused_at) {
    const pausedAt = issue.pipeline_paused_at;
    try {
      const hook = await getHookByToken(
        ingestHookToken(body.bookId, body.issueId, pausedAt),
      );
      return refuse(hook.runId, `paused at ${pausedAt}`);
    } catch (err) {
      const notFound =
        HookNotFoundError.is(err) ||
        (err instanceof Error && /hook not found/i.test(err.message));
      if (!notFound) return checkFailed(`the run paused at ${pausedAt}`, err);
      stale.push(`pause flag at ${pausedAt} with no hook`);
    }
  } else if (issue.pipeline_paused) {
    stale.push("pause flag with no pipeline_paused_at");
  }

  for (const row of openRuns ?? []) {
    const runId = row.steps?.runId;
    if (!runId) {
      stale.push(`running row ${row.id} with no runId`);
      continue;
    }
    try {
      const status = await getRun(runId).status;
      if (status === "pending" || status === "running") {
        return refuse(
          runId,
          `${status} (pipeline_step ${issue.pipeline_step ?? "unknown"})`,
        );
      }
      stale.push(`running row ${row.id} whose run ${runId} is ${status}`);
    } catch (err) {
      if (!WorkflowRunNotFoundError.is(err)) {
        return checkFailed(`run ${runId}`, err);
      }
      stale.push(`running row ${row.id} whose run ${runId} is not found`);
    }
  }

  if (stale.length > 0) {
    console.log(
      `[trigger-ingest] ${label}: treating as stale, starting anyway: ${stale.join("; ")}`,
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
