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
 * Append a skip record to pipeline_runs.steps.skipped on this run's row
 * (updateRunSteps matches it by runId). A missing row or a failed write is
 * logged; the record is returned either way.
 */
async function appendSkipRecord(
  client: Parameters<typeof updateRunSteps>[0],
  bookId: string,
  issueId: string,
  record: Json,
): Promise<void> {
  await updateRunSteps(
    client,
    bookId,
    issueId,
    getWorkflowMetadata().workflowRunId,
    (steps) => ({
      ...steps,
      skipped: [...(Array.isArray(steps.skipped) ? steps.skipped : []), record],
    }),
    "gate-skip",
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

  await appendSkipRecord(client, bookId, issueId, record as Json);

  return record;
}

/**
 * Open or close a review gate's paused window on
 * pipeline_runs.steps.gateWaits. Call it with "open" just before awaiting
 * the gate's hook and "close" just after, so the window covers exactly the
 * paused time and nothing else. Both calls are steps, so both timestamps
 * are wall clock, not the workflow body's seeded Date (#255).
 *
 * Both halves are idempotent, because the SDK replays a step that already
 * committed. A retried open leaves the existing open record alone, and a
 * close releases every still-open record for the gate, so no row is ever
 * left open and the rest of the run never reads as gate wait.
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

  let changed = false;
  await updateRunSteps(
    client,
    bookId,
    issueId,
    getWorkflowMetadata().workflowRunId,
    (steps) => {
      const waits = Array.isArray(steps.gateWaits)
        ? (steps.gateWaits as GateWaitRecord[])
        : [];
      if (event === "open") {
        if (waits.some((w) => w.gate === gate && w.releasedAt === undefined)) {
          return steps;
        }
        changed = true;
        return {
          ...steps,
          gateWaits: [...waits, { gate, waitedAt: at } as Json],
        };
      }
      const open = waits.some(
        (w) => w.gate === gate && w.releasedAt === undefined,
      );
      if (!open) return steps;
      changed = true;
      return {
        ...steps,
        gateWaits: waits.map((w) =>
          w.gate === gate && w.releasedAt === undefined
            ? ({ ...w, releasedAt: at } as Json)
            : (w as Json),
        ),
      };
    },
    "gate-wait",
  );
  if (!changed) {
    console.log(
      event === "open"
        ? `[gate-wait] ${gate} on ${bookId}/${issueId} already had an open record; second open dropped`
        : `[gate-wait] ${gate} on ${bookId}/${issueId} had no open record; close dropped`,
    );
  }
}
