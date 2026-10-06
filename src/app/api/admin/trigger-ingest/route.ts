import "server-only";
import { type NextRequest } from "next/server";
import { getHookByToken, getRun, start } from "workflow/api";
import { HookNotFoundError, WorkflowRunNotFoundError } from "workflow/errors";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { ingestPipeline } from "~/workflows/ingest-pipeline";
import { selectIssue, updateIssue } from "~/lib/issue-queries";
import { resolvePipelineStep } from "~/lib/pipeline-steps";
import { PAUSE_TO_HOOK_STEP, ingestHookToken } from "../cancel-ingest/hooks";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    bookId: string;
    issueId: string;
    fromStep?: unknown;
  };

  if (!body.bookId || !body.issueId) {
    return Response.json(
      { error: "missing bookId or issueId" },
      { status: 400 },
    );
  }

  // A retired step resolves to the step that does its work now; a name the
  // workflow cannot place is refused here, before any write or run (#356).
  const fromStep =
    body.fromStep === undefined || body.fromStep === null
      ? undefined
      : typeof body.fromStep === "string"
        ? resolvePipelineStep(body.fromStep)
        : null;
  if (fromStep === null) {
    return Response.json(
      { error: `unknown fromStep ${JSON.stringify(body.fromStep)}` },
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

  // Masks run on a finished issue only (#356).
  if (
    fromStep === "extract-foreground-masks" &&
    issue.pipeline_step !== "complete"
  ) {
    return Response.json(
      {
        error: `Masks can only be retried on a finished issue; this one reads ${issue.pipeline_step ?? "no step"}.`,
      },
      { status: 409 },
    );
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

  // One remedy fits every state: cancel-ingest given a runId cancels any
  // live run of the issue (#242).
  const pausedAt = issue.pipeline_paused ? issue.pipeline_paused_at : null;
  const refuse = (runId: string, state: string) =>
    Response.json(
      {
        error: `Run ${runId} of ${label} is ${state}. Cancel that run first, with the Cancel run button in admin or a cancel-ingest request naming its runId, then trigger again.`,
        runId,
        pausedAt,
        pipelineStep: issue.pipeline_step,
      },
      { status: 409 },
    );
  const stale: string[] = [];

  for (const gate of Object.keys(PAUSE_TO_HOOK_STEP)) {
    try {
      const hook = await getHookByToken(
        ingestHookToken(body.bookId, body.issueId, gate),
      );
      return refuse(hook.runId, `paused at ${gate}`);
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

  // A masks-only retry leaves pipeline_step alone: masks never write it, and
  // the run leaves the issue row as it found it (#356).
  const { error } = await updateIssue(
    supabaseAdmin,
    body.bookId,
    body.issueId,
    {
      ...(fromStep === "extract-foreground-masks"
        ? {}
        : { pipeline_step: fromStep ?? "roboflow-page-analyze" }),
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
      fromStep,
    },
  ]);

  const { error: runError } = await supabaseAdmin.from("pipeline_runs").insert({
    book_id: body.bookId,
    issue_id: body.issueId,
    status: "running",
    steps: {
      runId: run.runId,
      fromStep: fromStep ?? null,
      skipped: [],
    },
  });

  if (runError) {
    console.error("pipeline_runs insert failed after start():", runError);
    return Response.json({
      ok: true,
      bookId: body.bookId,
      issueId: body.issueId,
      fromStep: fromStep ?? null,
      runId: run.runId,
      status: "started",
      warning: runError.message,
    });
  }

  return Response.json({
    ok: true,
    bookId: body.bookId,
    issueId: body.issueId,
    fromStep: fromStep ?? null,
    runId: run.runId,
    status: "started",
  });
}
