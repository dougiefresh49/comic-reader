import { getWorkflowMetadata } from "workflow";
import type { Json } from "~/types/database";
import type { createTypedStepClient } from "../step-utils";

type StepClient = Awaited<ReturnType<typeof createTypedStepClient>>;
export type RunSteps = Record<string, Json | undefined>;

const STEPS_WRITE_ATTEMPTS = 5;

/**
 * Read-modify-write of this run's pipeline_runs.steps, the only place that
 * writes steps after trigger-ingest's insert. The row is matched by
 * steps->>runId and status 'running', as closePipelineRun matches it; a
 * pre-#147 row has no runId and is never written. The update is a
 * compare-and-swap: it also filters on steps being equal (jsonb equality)
 * to what was read, so a concurrent writer makes it match zero rows and it
 * reads again and reapplies `next`, up to STEPS_WRITE_ATTEMPTS times. Every
 * failure is logged, not thrown. The return says whether the update landed,
 * so a caller that cannot carry on with a wrong record (a timing window
 * closing on the edge of a review gate) can fail the step instead.
 */
export async function updateRunSteps(
  client: StepClient,
  bookId: string,
  issueId: string,
  runId: string,
  next: (steps: RunSteps) => RunSteps,
  logTag: string,
): Promise<boolean> {
  const where = `${bookId}/${issueId} run ${runId}`;
  for (let attempt = 1; attempt <= STEPS_WRITE_ATTEMPTS; attempt++) {
    const { data: rows, error: readErr } = await client
      .from("pipeline_runs")
      .select("id, steps")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("steps->>runId", runId)
      .eq("status", "running")
      .limit(1);
    if (readErr) {
      console.log(
        `[${logTag}] pipeline_runs read failed for ${where}: ${readErr.message}`,
      );
      return false;
    }
    const row = rows?.[0];
    if (!row) {
      console.log(
        `[${logTag}] no running pipeline_runs row for ${where}; steps not written`,
      );
      return false;
    }

    const current = row.steps as RunSteps;
    const { data: written, error: writeErr } = await client
      .from("pipeline_runs")
      .update({ steps: next(current) as Json })
      .eq("id", row.id)
      .eq("status", "running")
      .eq("steps", JSON.stringify(current))
      .select("id");
    if (writeErr) {
      console.log(
        `[${logTag}] pipeline_runs write failed for ${where}: ${writeErr.message}`,
      );
      return false;
    }
    if (written && written.length > 0) return true;
  }
  console.log(
    `[${logTag}] steps changed under every one of ${STEPS_WRITE_ATTEMPTS} writes for ${where}; gave up`,
  );
  return false;
}

/**
 * Close this run's pipeline_runs row. Matches the row by steps->>runId,
 * the run's own id, and only while it still reads 'running', so a row
 * cancel-ingest already marked 'cancelled' is left alone. A run with no
 * row (trigger-ingest's insert failed) logs that and returns. A failed write
 * is logged, not thrown, so it cannot fail the run or mask its own error.
 */
export async function closePipelineRun(
  bookId: string,
  issueId: string,
  status: "completed" | "failed",
): Promise<void> {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const { workflowRunId } = getWorkflowMetadata();
  const client = await createTypedStepClient();

  const { data, error } = await client
    .from("pipeline_runs")
    .update({ status, completed_at: new Date().toISOString() })
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("steps->>runId", workflowRunId)
    .eq("status", "running")
    .select("id");

  if (error) {
    console.log(
      `[pipeline-runs] ${status} write failed for ${bookId}/${issueId} run ${workflowRunId}: ${error.message}`,
    );
    return;
  }
  if (!data || data.length === 0) {
    console.log(
      `[pipeline-runs] no running row for ${bookId}/${issueId} run ${workflowRunId}; nothing marked ${status}`,
    );
  }
}
