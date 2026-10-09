import { claimHeld, CLAIM_STALE_MS } from "~/lib/voice-slots/claim";
import { listVoices } from "~/lib/voice-slots/elevenlabs";
import { readVoiceClaims } from "~/lib/voice-slots/moves";
import { errorMessage, matchLostAdd } from "~/lib/voice-slots/operation";
import {
  finishArchive,
  markRestored,
  readVoice,
} from "~/lib/voice-slots/registry";
import type { VoiceSlotsDeps } from "~/lib/voice-slots/types";
import { finishAdd, moveRecorder, type MoveOp } from "./run";
import type { AddMove, Move, MoveStatus } from "./types";

interface MoveRowRead {
  id: string;
  seq: number;
  book_id: string;
  issue_id: string;
  voice_uuid: string | null;
  status: MoveStatus;
  payload: Move;
  operation: MoveOp | null;
  operation_at: string | null;
}

export interface ReconcileOutcome {
  seq: number;
  status: MoveStatus | "skipped";
  reasons: string[];
}

/**
 * Settles the moves a `runMoves` run left open (`pending` or
 * `needs_attention` with an operation record), from each record, the way
 * the voices stop's `reconcile` settles an item. It never spends: free
 * ElevenLabs GETs and row writes only. A record a live run may still be
 * writing (stamped within the claim window, or a claim held on its voice)
 * is skipped. `notAdded`: the owner checked ElevenLabs and an add whose
 * reply was lost did not land.
 *
 * - `claimed`, `backing_up`, `backed_up`: nothing was deleted or added; failed.
 * - `archiving`: done when the voice is gone from the account (the registry
 *   writes are finished), failed when it is still there.
 * - `archived`: the registry writes are finished; done.
 * - `adding`: the voice carrying the add's token is adopted and the rows
 *   finished (done); a `back` add (restoring an archived voice after a
 *   refused add) is adopted onto that voice's row, and the move failed.
 * - `added`: the rows are finished; done.
 *
 * Moves a stopped run never started stay `pending` with no record.
 */
export async function reconcileRun(
  deps: VoiceSlotsDeps,
  runId: string,
  opts: { notAdded?: boolean } = {},
): Promise<ReconcileOutcome[]> {
  const sb = deps.supabase;
  const { data, error } = await sb
    .from("casting_moves")
    .select(
      "id, seq, book_id, issue_id, voice_uuid, status, payload, operation, operation_at",
    )
    .eq("run_id", runId)
    .in("status", ["pending", "needs_attention"])
    .not("operation", "is", null)
    .order("seq");
  if (error)
    throw new Error(`casting moves: reading run ${runId}: ${error.message}`);
  const out: ReconcileOutcome[] = [];
  for (const row of (data ?? []) as MoveRowRead[]) {
    out.push({ seq: row.seq, ...(await reconcileMove(deps, row, opts)) });
  }
  return out;
}

async function reconcileMove(
  deps: VoiceSlotsDeps,
  row: MoveRowRead,
  opts: { notAdded?: boolean },
): Promise<Omit<ReconcileOutcome, "seq">> {
  const sb = deps.supabase;
  const op = row.operation!;
  const skip = (why: string) => ({
    status: "skipped" as const,
    reasons: [why],
  });
  if (
    row.operation_at &&
    Date.parse(row.operation_at) >= Date.now() - CLAIM_STALE_MS
  )
    return skip("a run is still in progress");
  const ids = [row.voice_uuid, op.archived].filter((id): id is string =>
    Boolean(id),
  );
  if ((await readVoiceClaims(sb, ids)).some(claimHeld))
    return skip("a run is still in progress");

  const rec = moveRecorder(sb, row.id, op);
  const settle = async (status: MoveStatus, ...reasons: string[]) => {
    await rec.settle(status, [
      "reconciled from the recorded operation",
      ...reasons,
    ]);
    return { status, reasons };
  };
  const archivedRow = op.archived ? await readVoice(sb, op.archived) : null;
  const finish = async (elevenLabsId: string) => {
    await finishAdd(
      deps,
      { bookId: row.book_id, issueId: row.issue_id, rowId: row.id },
      row.payload as AddMove,
      elevenLabsId,
      false,
    );
    return settle("done", `recorded ${elevenLabsId}`);
  };

  try {
    switch (op.phase) {
      case "claimed":
      case "backing_up":
      case "backed_up":
        return await settle("failed", "nothing was deleted or added");
      case "archiving":
      case "archived": {
        // An add's record at `archived`: its own add and the bring-back of
        // the voice archived to make room were both refused.
        if (row.payload.kind !== "archive")
          return await settle(
            "failed",
            "the move's own add was refused",
            `${archivedRow?.display_name ?? op.archived} stays archived; restore it from /admin/voices`,
          );
        if (!archivedRow || !op.archivedElevenLabsId)
          return {
            status: "needs_attention",
            reasons: ["the record does not name the archived voice"],
          };
        if (op.phase === "archiving") {
          const present = (await listVoices(deps)).some(
            (v) => v.voice_id === op.archivedElevenLabsId,
          );
          if (present)
            return await settle(
              "failed",
              `the DELETE of ${archivedRow.display_name} did not land; nothing changed`,
            );
        }
        await finishArchive(sb, archivedRow, op.archivedElevenLabsId);
        return await settle("done", `${archivedRow.display_name} is archived`);
      }
      case "adding": {
        const found = await matchLostAdd(deps, op);
        if (op.back) {
          // The id goes only onto the state the bring-back found: archived, no id.
          if (
            found.ok &&
            !(
              archivedRow?.status === "archived" &&
              archivedRow.current_elevenlabs_id === null
            )
          )
            return await settle(
              "needs_attention",
              `${found.id} is a restore of ${archivedRow?.display_name ?? op.archived}, but that row is ${archivedRow?.status ?? "gone"} with ${archivedRow?.current_elevenlabs_id ?? "no id"} now; nothing was written (delete ${found.id} on ElevenLabs by hand if it is a duplicate)`,
            );
          if (found.ok) await markRestored(sb, archivedRow!, found.id);
          if (found.ok || opts.notAdded)
            return await settle(
              "failed",
              "the move's own add was refused",
              found.ok
                ? `${archivedRow?.display_name ?? op.archived} came back as ${found.id}`
                : `${archivedRow?.display_name ?? op.archived} stays archived; restore it from /admin/voices`,
            );
          return { status: "needs_attention", reasons: [found.why] };
        }
        if (!found.ok)
          return opts.notAdded
            ? await settle("failed", "the owner confirmed the add did not land")
            : { status: "needs_attention", reasons: [found.why] };
        await rec.record({ phase: "added", elevenLabsId: found.id });
        return await finish(found.id);
      }
      case "added":
        return await finish(op.elevenLabsId!);
      default:
        return {
          status: "needs_attention",
          reasons: [`no reconcile for phase ${op.phase}`],
        };
    }
  } catch (err) {
    // Kept on the row, so the next look at the run says why.
    const why = `reconcile stopped: ${errorMessage(err)}`;
    try {
      return await settle("needs_attention", why);
    } catch {
      return { status: "needs_attention", reasons: [why] };
    }
  }
}
