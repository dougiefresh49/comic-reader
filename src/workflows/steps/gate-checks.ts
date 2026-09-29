import { getWorkflowMetadata } from "workflow";
import type { Json } from "~/types/database";
import type { UnresolvedFaceCounts } from "./gate-counts";
import { updateRunSteps } from "./pipeline-runs";

export type { UnresolvedFaceCounts };

export type GateSkipRecord = {
  gate: string;
  reason: string;
  counts: Record<string, number>;
  at: string;
};

/** Count unresolved face detections + exemplars for the cluster gate. */
export async function countUnresolvedFaces(
  bookId: string,
  issueId: string,
): Promise<UnresolvedFaceCounts> {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const { countUnresolvedFaces: queryUnresolvedFaces } = await import(
    "./gate-counts"
  );
  const client = await createTypedStepClient();
  return queryUnresolvedFaces(client, bookId, issueId);
}

/** Count pending new-character queue rows for the character gate. */
export async function countPendingNewCharacters(
  bookId: string,
  issueId: string,
): Promise<number> {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const { countPendingNewCharacters: queryPendingNewCharacters } = await import(
    "./gate-counts"
  );
  const client = await createTypedStepClient();
  return queryPendingNewCharacters(client, bookId, issueId);
}

/**
 * Append a skip record to pipeline_runs.steps.skipped on this run's row
 * (updateRunSteps matches it by runId). A missing row or a failed write is
 * logged; the record is returned either way.
 */
export async function recordGateSkip(
  bookId: string,
  issueId: string,
  gate: string,
  reason: string,
  counts: Record<string, number>,
): Promise<GateSkipRecord> {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const client = await createTypedStepClient();

  const record: GateSkipRecord = {
    gate,
    reason,
    counts,
    at: new Date().toISOString(),
  };

  await updateRunSteps(
    client,
    bookId,
    issueId,
    getWorkflowMetadata().workflowRunId,
    (steps) => ({
      ...steps,
      skipped: [
        ...(Array.isArray(steps.skipped) ? steps.skipped : []),
        record as Json,
      ],
    }),
    "gate-skip",
  );

  return record;
}
