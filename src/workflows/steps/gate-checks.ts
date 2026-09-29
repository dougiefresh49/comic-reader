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

/**
 * One review gate's paused window on pipeline_runs.steps.gateWaits, kept
 * apart from step work time because it is Doug's thinking time, not the
 * pipeline's. `releasedAt` is absent while the run still sits paused (#255).
 * A skipped gate never calls the recorder, so it has no wait record.
 */
export type GateWaitRecord = {
  gate: string;
  waitedAt: string;
  releasedAt?: string;
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
 * Append one record to an array key on pipeline_runs.steps for this run
 * (updateRunSteps matches it by runId). A missing row or a failed write is
 * logged by updateRunSteps; the record is returned either way.
 */
async function appendGateRecord<K extends "skipped" | "gateWaits">(
  client: Parameters<typeof updateRunSteps>[0],
  bookId: string,
  issueId: string,
  key: K,
  record: Json,
  logTag: string,
): Promise<void> {
  await updateRunSteps(
    client,
    bookId,
    issueId,
    getWorkflowMetadata().workflowRunId,
    (steps) => ({
      ...steps,
      [key]: [...(Array.isArray(steps[key]) ? steps[key] : []), record],
    }),
    logTag,
  );
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

  await appendGateRecord(
    client,
    bookId,
    issueId,
    "skipped",
    record as Json,
    "gate-skip",
  );

  return record;
}

/**
 * Open or close a review gate's paused window on
 * pipeline_runs.steps.gateWaits. Call it with "open" just before awaiting
 * the gate's hook and "close" just after, so the window covers exactly the
 * paused time and nothing else. Both calls are steps, so both timestamps
 * are wall clock, not the workflow body's seeded Date (#255).
 */
export async function recordGateWait(
  bookId: string,
  issueId: string,
  gate: string,
  event: "open" | "close",
): Promise<void> {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const client = await createTypedStepClient();
  const at = new Date().toISOString();

  const record: GateWaitRecord = { gate, waitedAt: at };

  if (event === "open") {
    await appendGateRecord(
      client,
      bookId,
      issueId,
      "gateWaits",
      record as Json,
      "gate-wait",
    );
    return;
  }

  // Close the gate's open record in place rather than appending a second
  // one, so a gate that Doug visits twice reads as two windows and a gate
  // with no open record is logged, not silently given a zero-length wait.
  let closed = false;
  await updateRunSteps(
    client,
    bookId,
    issueId,
    getWorkflowMetadata().workflowRunId,
    (steps) => {
      const waits = Array.isArray(steps.gateWaits)
        ? (steps.gateWaits as GateWaitRecord[])
        : [];
      const index = waits.findIndex(
        (w) => w.gate === gate && w.releasedAt === undefined,
      );
      if (index === -1) return steps;
      closed = true;
      const next = [...waits];
      next[index] = { ...next[index], releasedAt: at } as GateWaitRecord;
      return { ...steps, gateWaits: next as Json[] };
    },
    "gate-wait",
  );
  if (!closed) {
    console.log(
      `[gate-wait] no open wait recorded for ${gate} on ${bookId}/${issueId}; close dropped`,
    );
  }
}
