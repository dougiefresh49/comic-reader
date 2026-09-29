import "server-only";
import { type NextRequest } from "next/server";
import { getHookByToken, getRun } from "workflow/api";
import { HookNotFoundError, WorkflowRunNotFoundError } from "workflow/errors";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { PAUSE_TO_HOOK_STEP, ingestHookToken } from "./hooks";
import { selectIssue, updateIssue } from "~/lib/issue-queries";

type PipelineRunSteps = {
  runId?: string;
  fromStep?: string | null;
  skipped?: unknown;
};

type IssueState = {
  pipeline_step: string | null;
  pipeline_paused: boolean;
  pipeline_paused_at: string | null;
};

type StateRun =
  | { runId: string; fromHook: boolean }
  | { error: string; status: number };

function isHookNotFound(err: unknown): boolean {
  return (
    HookNotFoundError.is(err) ||
    (err instanceof Error && /hook not found/i.test(err.message))
  );
}

/** The run the issue row's current state belongs to: the pause's hook holder, else the newest running row. */
async function findStateRun(
  bookId: string,
  issueId: string,
  issue: IssueState,
): Promise<StateRun> {
  if (issue.pipeline_paused && issue.pipeline_paused_at) {
    try {
      const hook = await getHookByToken(
        ingestHookToken(bookId, issueId, issue.pipeline_paused_at),
      );
      return { runId: hook.runId, fromHook: true };
    } catch (err) {
      if (isHookNotFound(err)) {
        return { error: "Hook not found for this pause", status: 404 };
      }
      return {
        error: err instanceof Error ? err.message : "Failed to look up hook",
        status: 500,
      };
    }
  }

  if (
    issue.pipeline_step === "complete" ||
    (issue.pipeline_step?.startsWith("failed:") ?? false)
  ) {
    return {
      error: "Issue is not cancellable in its current state",
      status: 409,
    };
  }

  const { data: runRow } = (await supabaseAdmin
    .from("pipeline_runs")
    .select("id, status, steps")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle()) as {
    data: {
      id: string;
      status: string;
      steps: PipelineRunSteps | null;
    } | null;
  };

  if (runRow && runRow.status !== "running") {
    return {
      error: `Newest pipeline run is ${runRow.status}, not running`,
      status: 409,
    };
  }

  const runId = runRow?.steps?.runId;
  if (!runId) {
    return { error: "No pipeline run found for this issue", status: 404 };
  }
  return { runId, fromHook: false };
}

/** Same two places trigger-ingest finds a live run: this issue's pipeline_runs rows and its gate hooks. */
async function isRunOfIssue(
  bookId: string,
  issueId: string,
  runId: string,
): Promise<boolean> {
  const { data: rows, error } = (await supabaseAdmin
    .from("pipeline_runs")
    .select("id")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .contains("steps", { runId })
    .limit(1)) as {
    data: Array<{ id: string }> | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(error.message);
  if (rows && rows.length > 0) return true;

  for (const gate of Object.keys(PAUSE_TO_HOOK_STEP)) {
    try {
      const hook = await getHookByToken(ingestHookToken(bookId, issueId, gate));
      if (hook.runId === runId) return true;
    } catch (err) {
      if (!isHookNotFound(err)) throw err;
    }
  }
  return false;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    bookId: string;
    issueId: string;
    runId?: unknown;
  };

  if (!body.bookId || !body.issueId) {
    return Response.json(
      { error: "missing bookId or issueId" },
      { status: 400 },
    );
  }

  if (
    body.runId !== undefined &&
    (typeof body.runId !== "string" || body.runId === "")
  ) {
    return Response.json(
      { error: "runId must be a non-empty string" },
      { status: 400 },
    );
  }
  const namedRunId = body.runId;

  const { data: issue } = (await selectIssue(
    supabaseAdmin,
    body.bookId,
    body.issueId,
    "id, pipeline_step, pipeline_paused, pipeline_paused_at",
  ).single()) as {
    data: ({ id: string } & IssueState) | null;
  };

  if (!issue) {
    return Response.json({ error: "issue not found" }, { status: 404 });
  }

  const stateRun = await findStateRun(body.bookId, body.issueId, issue);

  let runId: string;
  let runIdFromHook: boolean;
  // Only the run the issue row's state belongs to may rewrite that row; an
  // older run cancelled by id leaves `complete` or another run's pause alone.
  let ownsIssueState: boolean;

  if (namedRunId === undefined) {
    if ("error" in stateRun) {
      return Response.json(
        { error: stateRun.error },
        { status: stateRun.status },
      );
    }
    runId = stateRun.runId;
    runIdFromHook = stateRun.fromHook;
    ownsIssueState = true;
  } else {
    if ("error" in stateRun && stateRun.status === 500) {
      return Response.json({ error: stateRun.error }, { status: 500 });
    }
    ownsIssueState = "runId" in stateRun && stateRun.runId === namedRunId;
    runIdFromHook = "runId" in stateRun && ownsIssueState && stateRun.fromHook;
    if (!ownsIssueState) {
      let belongs: boolean;
      try {
        belongs = await isRunOfIssue(body.bookId, body.issueId, namedRunId);
      } catch (err) {
        return Response.json(
          {
            error:
              err instanceof Error
                ? err.message
                : "Failed to check which issue the run belongs to",
          },
          { status: 500 },
        );
      }
      if (!belongs) {
        return Response.json(
          {
            error: `Run ${namedRunId} is not a run of ${body.bookId}/${body.issueId}`,
          },
          { status: 404 },
        );
      }
    }
    runId = namedRunId;
  }

  // Confirm the run is live before cancel() and before any write.
  let run: ReturnType<typeof getRun>;
  try {
    run = getRun(runId);
    const status = await run.status;
    if (status !== "pending" && status !== "running") {
      return Response.json(
        { error: `Run ${runId} is ${status}, not live` },
        { status: 409 },
      );
    }
  } catch (err) {
    if (WorkflowRunNotFoundError.is(err)) {
      return Response.json(
        { error: `Run ${runId} not found` },
        { status: 404 },
      );
    }
    return Response.json(
      {
        error: err instanceof Error ? err.message : "Failed to read run status",
      },
      { status: 500 },
    );
  }

  try {
    await run.cancel();
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : "Failed to cancel run",
      },
      { status: 500 },
    );
  }

  const failedStep = ownsIssueState
    ? (issue.pipeline_paused_at ??
      (issue.pipeline_step?.startsWith("failed:")
        ? issue.pipeline_step.replace("failed:", "")
        : issue.pipeline_step) ??
      "error")
    : null;

  const warnings: string[] = [];

  if (failedStep !== null) {
    // Compare-and-set on the state read above: once cancel() frees the gate
    // hooks, a retrigger can start a new run and write its own state first.
    let guarded = updateIssue(supabaseAdmin, body.bookId, body.issueId, {
      pipeline_step: `failed:${failedStep}`,
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    }).eq("pipeline_paused", issue.pipeline_paused);
    guarded =
      issue.pipeline_step === null
        ? guarded.is("pipeline_step", null)
        : guarded.eq("pipeline_step", issue.pipeline_step);
    guarded =
      issue.pipeline_paused_at === null
        ? guarded.is("pipeline_paused_at", null)
        : guarded.eq("pipeline_paused_at", issue.pipeline_paused_at);

    const { data: updatedIssues, error: issueError } =
      await guarded.select("id");

    if (issueError) {
      return Response.json({ error: issueError.message }, { status: 500 });
    }
    if (!updatedIssues || updatedIssues.length === 0) {
      warnings.push(
        "Issue pipeline state changed during the cancel; issues row left as is",
      );
    }
  }

  const { data: updatedRuns, error: runError } = (await supabaseAdmin
    .from("pipeline_runs")
    .update({
      status: "cancelled",
      completed_at: new Date().toISOString(),
    })
    .eq("book_id", body.bookId)
    .eq("issue_id", body.issueId)
    .eq("status", "running")
    .contains("steps", { runId })
    .select("id")) as {
    data: Array<{ id: string }> | null;
    error: { message: string } | null;
  };

  if (runError) {
    return Response.json({ error: runError.message }, { status: 500 });
  }

  if (runIdFromHook && (!updatedRuns || updatedRuns.length === 0)) {
    warnings.push("No pipeline_runs row carried this runId; none updated");
  }

  return Response.json({
    ok: true,
    bookId: body.bookId,
    issueId: body.issueId,
    runId,
    failedStep,
    ...(warnings.length > 0 && { warning: warnings.join("; ") }),
  });
}
