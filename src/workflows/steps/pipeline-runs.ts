import { getWorkflowMetadata } from "workflow";

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
