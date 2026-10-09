/**
 * The recorded-operation machinery a slot-changing run shares (#351, lifted
 * for #786): the operation record and its phases, the claims on the
 * `voices` rows a run changes, how an add's failure is read, the lookup of
 * an add whose reply was lost, and `bringBack` (restoring the voice a run
 * archived after the add it made room for was refused). The voices stop's
 * `carryOut` keeps its record on `casting_tasks.operation`; the casting
 * moves keep theirs on `casting_moves.operation`. Both write through a
 * `Recorder`, so these helpers never name the table.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withVoiceOperationClaim, type VoiceClaimOperation } from "./claim";
import {
  ElevenLabsHeadroomError,
  ElevenLabsRefusedError,
  findOpVoices,
  listVoices,
} from "./elevenlabs";
import { markRestored, readVoice } from "./registry";
import { restoreVoice } from "./restore";
import type { VoiceRow, VoiceSlotsDeps } from "./types";

/**
 * A run in flight, recorded before and after each request that spends: the
 * claim's token, a `rev` that changes on every write (each write is a
 * compare-and-swap on it), the last phase reached, and what a reconcile
 * needs. Phases: `claimed` (nothing spent on ElevenLabs), `archiving`
 * (DELETE sent), `archived` (DELETE confirmed), `adding` (add sent, `before`
 * and `name` recorded), `added` (ElevenLabs id known), `retiring` (the new
 * voice is recorded; the outgoing voice's DELETE is sent) and `retired`
 * (that DELETE confirmed, its registry write failed). `back` marks an add
 * that restores the archived voice instead of making the run's own voice.
 */
export interface OpRecord {
  token: string;
  rev: string;
  phase:
    | "claimed"
    | "archiving"
    | "archived"
    | "adding"
    | "added"
    | "retiring"
    | "retired";
  back?: boolean;
  /** The claim wrote the request fields on a casting-step row; a give-back clears them. */
  converted?: boolean;
  /** `voices.id` archived for the run. */
  archived?: string;
  /** `voices.id` of the voice the run replaces, for the metadata copy. */
  replaces?: string;
  /** Its ElevenLabs id before the DELETE. */
  archivedElevenLabsId?: string;
  /** ElevenLabs ids on the account before the add. */
  before?: string[];
  /** The name the add used. */
  name?: string;
  elevenLabsId?: string;
}

/**
 * The phases whose last request has a known outcome. A run that returns at
 * one of them may clear its `operation_at` stamp so a reconcile need not
 * wait out the window; at the others a DELETE or add that timed out on this
 * side may still land.
 */
export const KNOWN_OUTCOME_PHASES: readonly string[] = [
  "claimed",
  "archived",
  "added",
  "retired",
];

/**
 * A run's record and its compare-and-swap writes, on whichever row holds
 * it. `op` names only what the shared helpers read, so a record with more
 * phases (the casting moves' backup) still fits.
 */
export interface Recorder {
  op: Pick<OpRecord, "token" | "archivedElevenLabsId" | "before" | "name">;
  /** Records the next phase; throws when the row no longer holds this run's record. */
  record: (next: Partial<OpRecord>) => Promise<void>;
}

/** What an add came to. */
export type Added =
  | { kind: "added"; elevenLabsId: string; recorded: boolean }
  | { kind: "refused"; reason: string }
  | { kind: "uncertain"; reason: string };

export const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** A 4xx or a pre-send refusal added nothing; a 5xx, a timeout or an unread reply may have. */
export function classify(err: unknown): Added {
  if (
    (err instanceof ElevenLabsRefusedError && (err.status ?? 0) < 500) ||
    err instanceof ElevenLabsHeadroomError
  )
    return { kind: "refused", reason: errorMessage(err) };
  return { kind: "uncertain", reason: errorMessage(err) };
}

/** The one voice a lost add made, by its token, name and the inventory before it. */
export async function matchLostAdd(
  deps: VoiceSlotsDeps,
  op: Pick<OpRecord, "token" | "before" | "name">,
): Promise<{ ok: true; id: string } | { ok: false; why: string }> {
  if (!op.before || !op.name)
    return { ok: false, why: "the add's inventory was not recorded" };
  try {
    const ids = await findOpVoices(deps, {
      token: op.token,
      name: op.name,
      before: op.before,
    });
    if (ids.length === 1) return { ok: true, id: ids[0]! };
    return {
      ok: false,
      why:
        ids.length === 0
          ? `no new ElevenLabs voice named "${op.name}" carries this add's token`
          : `${ids.length} new voices carry this add's token`,
    };
  } catch (err) {
    return { ok: false, why: `the lookup failed: ${errorMessage(err)}` };
  }
}

/**
 * Restores the voice a run archived after the add it made room for was
 * refused (the one paid recovery, run under the archived row's claim or
 * after it), as a recorded add: an `adding` record with `back`, a fresh
 * token and the inventory, so a lost reply is matched like any add and a
 * reconcile can finish the rows. A refusal puts the record back at
 * `archived`.
 */
export async function bringBack(
  deps: VoiceSlotsDeps,
  rec: Recorder,
  voice: VoiceRow,
  deleteConfirmed: boolean,
): Promise<{ ok: true } | { ok: false; why: string }> {
  let before: string[];
  try {
    before = (await listVoices(deps)).map((v) => v.voice_id);
  } catch (err) {
    return {
      ok: false,
      why: `could not list the account's voices before restoring ${voice.display_name}: ${errorMessage(err)}`,
    };
  }
  await rec.record({
    phase: "adding",
    back: true,
    token: randomUUID(),
    before,
    name: voice.display_name,
    archived: voice.id,
  });
  const row = await readVoice(deps.supabase, voice.id);
  if (!row) return { ok: false, why: `${voice.display_name}: row not found` };
  let added: Added;
  try {
    const r = await restoreVoice(deps, row, {
      execute: true,
      // Only while the row still holds the id whose DELETE was confirmed.
      deleteConfirmed:
        deleteConfirmed &&
        row.current_elevenlabs_id === rec.op.archivedElevenLabsId,
      opToken: rec.op.token,
    });
    added =
      r.executed && r.newElevenLabsId
        ? { kind: "added", elevenLabsId: r.newElevenLabsId, recorded: true }
        : { kind: "refused", reason: r.refusals.join(", ") };
  } catch (err) {
    added = classify(err);
  }
  if (added.kind === "added") return { ok: true };
  if (added.kind === "refused") {
    await rec.record({ phase: "archived", back: undefined });
    return {
      ok: false,
      why: `restoring ${voice.display_name} was refused: ${added.reason}`,
    };
  }
  const found = await matchLostAdd(deps, rec.op);
  if (!found.ok)
    return {
      ok: false,
      why: `restoring ${voice.display_name}: the reply was lost (${added.reason}); ${found.why}`,
    };
  await markRestored(deps.supabase, row, found.id);
  return { ok: true };
}

/** A claim on one of the run's `voices` rows did not land: another run holds it, or the row changed. Nothing was run. */
export class VoiceHeldError extends Error {
  constructor(
    public readonly voice: VoiceRow,
    cause: unknown,
  ) {
    super(errorMessage(cause));
    this.name = "VoiceHeldError";
  }
}

/**
 * Runs `run` while holding the operation claim on every row named, all
 * taken before it starts (`withVoiceOperationClaim`, nested; a row named
 * twice is claimed once, null entries are skipped). A claim that does not
 * land throws `VoiceHeldError` and `run` never starts; anything thrown after
 * it started is rethrown as it is.
 */
export async function withVoiceClaims<T>(
  supabase: SupabaseClient,
  claims: { row: VoiceRow | null; op: VoiceClaimOperation }[],
  run: () => Promise<T>,
): Promise<T> {
  const list: { row: VoiceRow; op: VoiceClaimOperation }[] = [];
  for (const c of claims)
    if (c.row && !list.some((l) => l.row.id === c.row!.id))
      list.push({ row: c.row, op: c.op });
  let started = false;
  let claiming: VoiceRow | null = null;
  const claimed = list.reduceRight<() => Promise<T>>(
    (inner, c) => () => {
      claiming = c.row;
      return withVoiceOperationClaim(supabase, c.row, c.op, inner);
    },
    () => {
      started = true;
      return run();
    },
  );
  try {
    return await claimed();
  } catch (err) {
    if (started || !claiming) throw err;
    throw new VoiceHeldError(claiming, err);
  }
}
