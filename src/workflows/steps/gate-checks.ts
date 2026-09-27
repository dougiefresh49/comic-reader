import type { Json } from "~/types/database";
import {
  countPendingNewCharacters as queryPendingNewCharacters,
  countUnresolvedFaces as queryUnresolvedFaces,
  type UnresolvedFaceCounts,
} from "./gate-counts";

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
  const client = await createTypedStepClient();
  return queryPendingNewCharacters(client, bookId, issueId);
}

/**
 * Append a skip record to pipeline_runs.steps.skipped on the latest
 * status='running' row for (book_id, issue_id). If no such row exists,
 * log and return the record unchanged.
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

  const { data: rows, error: selectError } = await client
    .from("pipeline_runs")
    .select("id, steps")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1);

  if (selectError) {
    console.log(
      `[gate-skip] pipeline_runs select failed for ${bookId}/${issueId}: ${selectError.message}`,
    );
    return record;
  }

  const row = rows?.[0];
  if (!row) {
    console.log(
      `[gate-skip] no running pipeline_runs row for ${bookId}/${issueId}; skip not persisted`,
    );
    return record;
  }

  const prev =
    row.steps !== null &&
    typeof row.steps === "object" &&
    !Array.isArray(row.steps)
      ? (row.steps as Record<string, Json | undefined>)
      : {};
  const prevSkipped = Array.isArray(prev.skipped) ? prev.skipped : [];
  const nextSteps = {
    ...prev,
    skipped: [...prevSkipped, record as Json],
  } as Json;

  const { error: updateError } = await client
    .from("pipeline_runs")
    .update({ steps: nextSteps })
    .eq("id", row.id);

  if (updateError) {
    console.log(
      `[gate-skip] pipeline_runs update failed for ${bookId}/${issueId}: ${updateError.message}`,
    );
  }

  return record;
}
