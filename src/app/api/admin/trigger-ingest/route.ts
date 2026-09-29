import "server-only";
import { type NextRequest } from "next/server";
import { getHookByToken, getRun, start } from "workflow/api";
import { HookNotFoundError, WorkflowRunNotFoundError } from "workflow/errors";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { ingestPipeline } from "~/workflows/ingest-pipeline";
import { selectIssue, updateIssue } from "~/lib/issue-queries";
import { PAUSE_TO_HOOK_STEP, ingestHookToken } from "../cancel-ingest/hooks";

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

  // Every run of an issue shares the gate hook tokens, so a second run dies
  // with HookConflictError while an older one holds a gate (#208). Refuse only
  // while that run is live; stale state passes, a lookup error refuses.
  const label = `${body.bookId}/${body.issueId}`;
  const checkFailed = (what: string, err: unknown) =>
    Response.json(
      {
        error: `Could not check whether ${what} of ${label} is still live, so nothing was started: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 409 },
    );

  const { data: runs, error: runsError } = (await supabaseAdmin
    .from("pipeline_runs")
    .select("id, status, steps")
    .eq("book_id", body.bookId)
    .eq("issue_id", body.issueId)
    .order("started_at", { ascending: false })) as {
    data: Array<{
      id: string;
      status: string;
      steps: { runId?: string } | null;
    }> | null;
    error: { message: string } | null;
  };
  if (runsError) return checkFailed("a run", new Error(runsError.message));

  // Mirrors cancel-ingest/route.ts: with a pause flag it cancels that gate's
  // hook holder; without one, the newest row's run unless the issue ended.
  const pausedAt = issue.pipeline_paused ? issue.pipeline_paused_at : null;
  const ended =
    issue.pipeline_step === "complete" ||
    (issue.pipeline_step?.startsWith("failed:") ?? false);
  const refuse = (runId: string, state: string, gate?: string) => {
    const newest = runs?.[0];
    const cancelIngestWorks = pausedAt
      ? gate === pausedAt
      : !ended && newest?.status === "running" && newest.steps?.runId === runId;
    const remedy = cancelIngestWorks
      ? "Cancel it first with cancel-ingest"
      : `cancel-ingest cannot cancel it from this state, so cancel run ${runId} with the Workflow CLI or the Workflow dashboard`;
    return Response.json(
      {
        error: `Run ${runId} of ${label} is ${state}. ${remedy}, then trigger again.`,
        runId,
        pausedAt,
        pipelineStep: issue.pipeline_step,
      },
      { status: 409 },
    );
  };
  const stale: string[] = [];

  for (const gate of Object.keys(PAUSE_TO_HOOK_STEP)) {
    try {
      const hook = await getHookByToken(
        ingestHookToken(body.bookId, body.issueId, gate),
      );
      return refuse(hook.runId, `paused at ${gate}`, gate);
    } catch (err) {
      if (!HookNotFoundError.is(err)) {
        return checkFailed(`a run paused at ${gate}`, err);
      }
    }
  }
  if (issue.pipeline_paused) {
    stale.push(`pause flag at ${pausedAt ?? "(none)"} with no hook`);
  }

  for (const row of runs ?? []) {
    if (row.status !== "running") continue;
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
