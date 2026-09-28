import "server-only";
import { type NextRequest } from "next/server";
import { getHookByToken, getRun } from "workflow/api";
import { HookNotFoundError, WorkflowRunNotFoundError } from "workflow/errors";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { ingestHookToken } from "./hooks";
import { selectIssue, updateIssue } from "~/lib/issue-queries";

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

  const { data: issue } = (await selectIssue(
    supabaseAdmin,
    body.bookId,
    body.issueId,
    "id, pipeline_step, pipeline_paused, pipeline_paused_at",
  ).single()) as {
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
  let runIdFromHook = false;

  if (issue.pipeline_paused && issue.pipeline_paused_at) {
    const token = ingestHookToken(
      body.bookId,
      body.issueId,
      issue.pipeline_paused_at,
    );
    try {
      const hook = await getHookByToken(token);
      runId = hook.runId;
      runIdFromHook = true;
    } catch (err) {
      if (
        HookNotFoundError.is(err) ||
        (err instanceof Error && /hook not found/i.test(err.message))
      ) {
        return Response.json(
          { error: "Hook not found for this pause" },
          { status: 404 },
        );
      }
      return Response.json(
        {
          error: err instanceof Error ? err.message : "Failed to look up hook",
        },
        { status: 500 },
      );
    }
  } else {
    if (
      issue.pipeline_step === "complete" ||
      (issue.pipeline_step?.startsWith("failed:") ?? false)
    ) {
      return Response.json(
        { error: "Issue is not cancellable in its current state" },
        { status: 409 },
      );
    }

    const { data: runRow } = (await supabaseAdmin
      .from("pipeline_runs")
      .select("id, status, steps")
      .eq("book_id", body.bookId)
      .eq("issue_id", body.issueId)
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
      return Response.json(
        { error: `Newest pipeline run is ${runRow.status}, not running` },
        { status: 409 },
      );
    }

    runId = runRow?.steps?.runId ?? null;
    if (!runId) {
      return Response.json(
        { error: "No pipeline run found for this issue" },
        { status: 404 },
      );
    }
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

  const failedStep =
    issue.pipeline_paused_at ??
    (issue.pipeline_step?.startsWith("failed:")
      ? issue.pipeline_step.replace("failed:", "")
      : issue.pipeline_step) ??
    "error";

  const { error: issueError } = await updateIssue(
    supabaseAdmin,
    body.bookId,
    body.issueId,
    {
      pipeline_step: `failed:${failedStep}`,
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    },
  );

  if (issueError) {
    return Response.json({ error: issueError.message }, { status: 500 });
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
    return Response.json({
      ok: true,
      bookId: body.bookId,
      issueId: body.issueId,
      runId,
      failedStep,
      warning: "No pipeline_runs row carried this runId; none updated",
    });
  }

  return Response.json({
    ok: true,
    bookId: body.bookId,
    issueId: body.issueId,
    runId,
    failedStep,
  });
}
