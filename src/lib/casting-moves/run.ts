import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { slugify } from "~/lib/character-id";
import {
  addToCast,
  castVoiceInBook,
  createCharacter,
  loadBookCast,
  readBookFranchises,
  removeFromCast,
  renameCharacter,
  setIssueVoice,
  setNoAudio,
} from "~/lib/cast";
import type { LlmCallMeta } from "~/lib/llm-usage";
import {
  ArchiveRecordError,
  archiveRefusalsCheap,
  archiveVoice,
} from "~/lib/voice-slots/archive";
import { createFromPreview } from "~/lib/voice-slots/design";
import { listVoices } from "~/lib/voice-slots/elevenlabs";
import {
  KNOWN_OUTCOME_PHASES,
  VoiceHeldError,
  bringBack,
  classify,
  errorMessage,
  matchLostAdd,
  withVoiceClaims,
  type Added,
  type OpRecord,
  type Recorder,
} from "~/lib/voice-slots/operation";
import {
  activateDesignedVoice,
  finishArchive,
  markRestored,
  readStoredDesign,
  readVoice,
  readVoices,
} from "~/lib/voice-slots/registry";
import { readVoicesByElevenLabsIds } from "~/lib/voice-slots/lookup";
import {
  fileVoiceUnder,
  markRunOnly,
  registerOutsideVoice,
  writeVoiceLabels,
} from "~/lib/voice-slots/moves";
import { restoreVoice } from "~/lib/voice-slots/restore";
import { snapshotSample } from "~/lib/voice-slots/snapshot";
import {
  isProtectedVoice,
  type VoiceRow,
  type VoiceSlotsDeps,
} from "~/lib/voice-slots/types";
import { readAccountOwners } from "./account";
import { blank, labelsMissing, minimalLabels } from "./labels";
import {
  castAwayReason,
  planMovesDetail,
  snapshotValid,
  type CastScope,
  type PlanDetail,
} from "./plan";
import type {
  AddMove,
  ArchiveMove,
  Move,
  MoveOutcome,
  MoveStatus,
  RunResult,
} from "./types";

/**
 * A move in flight, kept in its `casting_moves.operation`: the shared
 * `OpRecord` (token, rev, the add's inventory), with two more phases for an
 * archive's backup step (`backing_up`: snapshot and labels being written,
 * nothing deleted; `backed_up`: the voice can come back) and `history`, the
 * phase sequence with the time each was reached, so the run log shows the
 * snapshot written before the DELETE. The record stays on the row after the
 * move settles; `operation_at` is cleared once the last request's outcome
 * is known.
 */
export interface MoveOp extends Omit<OpRecord, "phase"> {
  phase: OpRecord["phase"] | "backing_up" | "backed_up";
  history: { phase: string; at: string }[];
  /** The bucket object the backup step left. */
  snapshot?: string | null;
  /** The backup step wrote minimal labels from the description. */
  labelsWritten?: boolean;
  /** Why the move ended as it did. */
  reasons?: string[];
}

interface MoveRecorder extends Recorder {
  op: MoveOp;
  record: (next: Partial<MoveOp>) => Promise<void>;
  /** Settles the row: its status, the reasons on the record, and `operation_at` cleared when the outcome is known. */
  settle: (status: MoveStatus, reasons: string[]) => Promise<void>;
}

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`casting moves: ${what}: ${error.message}`);
}

export function moveRecorder(
  sb: SupabaseClient,
  rowId: string,
  op: MoveOp,
): MoveRecorder {
  const write = async (to: MoveOp, extra: Record<string, unknown>) => {
    const { data, error } = await sb
      .from("casting_moves")
      .update({ operation: to, ...extra })
      .eq("id", rowId)
      .eq("operation->>rev", op.rev)
      .select("id");
    fail("writing a move's operation record", error);
    if ((data ?? []).length === 0)
      throw new Error("the move's operation record changed under this run");
    Object.assign(op, to);
  };
  return {
    op,
    record: (next) =>
      write(
        {
          ...op,
          ...next,
          rev: randomUUID(),
          history: [
            ...op.history,
            { phase: next.phase ?? op.phase, at: new Date().toISOString() },
          ],
        },
        // PostgreSQL timestamp input "now": the time comes from the database.
        { operation_at: "now" },
      ),
    settle: (status, reasons) =>
      write(
        { ...op, rev: randomUUID(), reasons },
        {
          status,
          ...(status !== "needs_attention" ||
          [...KNOWN_OUTCOME_PHASES, "backing_up", "backed_up"].includes(
            op.phase,
          )
            ? { operation_at: null }
            : {}),
        },
      ),
  };
}

/** The `casting_moves` row a move is written as at confirm. */
function moveRow(
  m: Move,
  base: { book_id: string; issue_id: string; run_id: string; seq: number },
) {
  return {
    ...base,
    kind: m.kind,
    character_id: "character_id" in m ? m.character_id : null,
    voice_uuid: "voice_uuid" in m ? m.voice_uuid : null,
    replaces_voice_uuid:
      "replaces_voice_uuid" in m ? (m.replaces_voice_uuid ?? null) : null,
    backup: m.kind === "archive" ? m.backup : false,
    lossy_ok: m.kind === "archive" ? m.lossy_ok : false,
    run_only: m.kind === "create_design" ? m.run_only : false,
    generated_voice_id:
      m.kind === "create_design" ? m.generated_voice_id : null,
    design_prompt: m.kind === "create_design" ? m.design_prompt : null,
    preview_text: m.kind === "create_design" ? m.preview_text : null,
    payload: m,
  };
}

interface Ctx {
  deps: VoiceSlotsDeps;
  bookId: string;
  issueId: string;
  moves: Move[];
  detail: PlanDetail;
  meta: LlmCallMeta;
  /** Archives this run carried out, by move index: the row before the DELETE. */
  archived: Map<number, { row: VoiceRow; deleteConfirmed: boolean }>;
}

type Ended = {
  status: MoveStatus;
  reasons: string[];
  voiceUuid?: string | null;
  elevenLabsId?: string | null;
};

const done = (reasons: string[] = [], extra: Partial<Ended> = {}): Ended => ({
  status: "done",
  reasons,
  ...extra,
});
const failed = (...reasons: string[]): Ended => ({ status: "failed", reasons });
const attention = (...reasons: string[]): Ended => ({
  status: "needs_attention",
  reasons,
});

/**
 * Runs the staged moves for one issue (#786), spending on ElevenLabs. It
 * plans first and refuses, writing nothing, when the plan has a blocker.
 * Then it writes one `casting_moves` row per move under one `run_id`,
 * numbered in run order, and runs them in that order:
 *
 * - Each move claims its row (its `operation`, compare-and-swap) and holds
 *   the operation claim on every `voices` row it changes, both before
 *   anything is spent.
 * - An archive with `backup` snapshots the voice when it has no valid
 *   snapshot and writes minimal labels from a non-blank description, both
 *   recorded (`backing_up`, `backed_up`) before the DELETE (`archiving`,
 *   `archived`). The hard refusals (protected, keep_active, room, pinned)
 *   are checked again under the claim before the first external call.
 * - A restore or design records `adding` with the account's inventory and a
 *   per-add token, so a lost reply is matched, and `added` with the new id.
 *   An add refused after an archive freed its slot brings that voice back
 *   (`bringBack`).
 * - The first move that fails or needs attention stops the run; the moves
 *   after it stay `pending` and are not run. `reconcileRun` settles a move
 *   left needing attention.
 */
export async function runMoves(
  deps: VoiceSlotsDeps,
  bookId: string,
  issueId: string,
  moves: Move[],
): Promise<RunResult> {
  const sb = deps.supabase;
  const detail = await planMovesDetail(deps, bookId, issueId, moves);
  if (detail.plan.blockers.length > 0)
    return { status: "refused", runId: null, blockers: detail.plan.blockers };

  const runId = randomUUID();
  const ins = await sb
    .from("casting_moves")
    .insert(
      detail.order.map((i, seq) =>
        moveRow(moves[i]!, {
          book_id: bookId,
          issue_id: issueId,
          run_id: runId,
          seq,
        }),
      ),
    )
    .select("id, seq");
  fail("writing the run's moves", ins.error);
  const rowIdBySeq = new Map(
    ((ins.data ?? []) as { id: string; seq: number }[]).map((r) => [
      r.seq,
      r.id,
    ]),
  );

  const ctx: Ctx = {
    deps,
    bookId,
    issueId,
    moves,
    detail,
    meta: { step: "casting-moves", bookId, issueId },
    archived: new Map(),
  };
  const outcomes: MoveOutcome[] = [];
  let stopped = false;
  for (const [seq, i] of detail.order.entries()) {
    const m = moves[i]!;
    if (stopped) {
      outcomes.push({
        moveIndex: i,
        seq,
        kind: m.kind,
        status: "pending",
        reasons: ["not run: an earlier move stopped the run"],
      });
      continue;
    }
    const ended = await runOne(ctx, i, rowIdBySeq.get(seq)!);
    outcomes.push({ moveIndex: i, seq, kind: m.kind, ...ended });
    if (ended.status !== "done") stopped = true;
  }
  return {
    status: stopped ? "stopped" : "done",
    runId,
    plan: detail.plan,
    moves: outcomes,
  };
}

/** Claims the move's row, runs it, and settles the row. */
async function runOne(ctx: Ctx, i: number, rowId: string): Promise<Ended> {
  const sb = ctx.deps.supabase;
  const op: MoveOp = {
    token: randomUUID(),
    rev: randomUUID(),
    phase: "claimed",
    history: [{ phase: "claimed", at: new Date().toISOString() }],
  };
  const claim = await sb
    .from("casting_moves")
    .update({ operation: op, operation_at: "now" })
    .eq("id", rowId)
    .eq("status", "pending")
    .is("operation", null)
    .select("id");
  fail("claiming a move", claim.error);
  if ((claim.data ?? []).length === 0)
    return failed("another run claimed this move first");
  const rec = moveRecorder(sb, rowId, op);

  let ended: Ended;
  try {
    ended = await runClaimed(ctx, i, rowId, rec);
  } catch (err) {
    if (err instanceof VoiceHeldError)
      ended = failed(
        `${err.voice.display_name} is held by another run (${err.message}); nothing was spent`,
      );
    else if (["claimed", "backing_up", "backed_up"].includes(op.phase))
      ended = failed(`stopped before any slot change: ${errorMessage(err)}`);
    else
      ended = attention(
        `stopped after ${op.phase}: ${errorMessage(err)}`,
        "the operation is recorded on the move; run reconcile",
      );
  }
  try {
    await rec.settle(ended.status, ended.reasons);
  } catch (err) {
    return attention(
      ...ended.reasons,
      `the move ended ${ended.status}, but settling its row failed: ${errorMessage(err)}`,
    );
  }
  return ended;
}

async function runClaimed(
  ctx: Ctx,
  i: number,
  rowId: string,
  rec: MoveRecorder,
): Promise<Ended> {
  const m = ctx.moves[i]!;
  switch (m.kind) {
    case "archive":
      return runArchive(ctx, i, m, rowId, rec);
    case "restore":
    case "create_design":
      return runAdd(ctx, i, m, rowId, rec);
    default:
      return runCastMove(ctx, m, rowId);
  }
}

/** `castAwayReason` on the cast and voices as they are now: the re-check before a cast write or an add. */
async function protectedOwnVoice(
  ctx: Ctx,
  characterId: string,
  to: string | null,
  scope: CastScope,
): Promise<string | null> {
  const sb = ctx.deps.supabase;
  const [book, voices] = await Promise.all([
    loadBookCast(sb, ctx.bookId),
    readVoices(sb),
  ]);
  const byId = new Map(voices.map((v) => [v.id, v]));
  return castAwayReason(
    book,
    (uuid) => {
      const row = byId.get(uuid);
      return row && isProtectedVoice(row) ? row.display_name : null;
    },
    characterId,
    ctx.issueId,
    scope,
    to,
  );
}

/**
 * A `voices` row for another project's voice that an archive names by its
 * ElevenLabs id, so the backup and the archive record have a row to hang
 * on. No consumer (it is not this repo's) and no character; the account's
 * name, description and labels.
 */
async function registerOutside(
  ctx: Ctx,
  i: number,
  elevenLabsId: string,
): Promise<VoiceRow> {
  const sb = ctx.deps.supabase;
  const id = (await readVoicesByElevenLabsIds(sb, [elevenLabsId]))[0]?.id;
  const held = id ? await readVoice(sb, id) : null;
  if (held) return held;
  const acct = ctx.detail.outside.get(i);
  if (!acct) throw new Error(`${elevenLabsId} is not on the account`);
  return registerOutsideVoice(sb, {
    name: acct.name || elevenLabsId,
    elevenLabsId,
    description: acct.description,
    labels: labelsMissing(acct.labels) ? null : acct.labels,
  });
}

async function runArchive(
  ctx: Ctx,
  i: number,
  m: ArchiveMove,
  rowId: string,
  rec: MoveRecorder,
): Promise<Ended> {
  const { deps } = ctx;
  const sb = deps.supabase;
  let row = m.voice_uuid
    ? await readVoice(sb, m.voice_uuid)
    : await registerOutside(ctx, i, m.elevenlabs_id!);
  if (!row) return failed(`no voice ${m.voice_uuid}`);
  if (!m.voice_uuid) {
    const upd = await sb
      .from("casting_moves")
      .update({ voice_uuid: row.id })
      .eq("id", rowId);
    fail("recording the registered voice on the move", upd.error);
  }
  const name = row.display_name;

  return withVoiceClaims(sb, [{ row, op: "archive" }], async () => {
    /** The hard refusals, read fresh, before each external call. */
    const hard = async (voice: VoiceRow): Promise<string | null> => {
      const owners = await readAccountOwners(sb);
      const pin = voice.current_elevenlabs_id
        ? owners.get(voice.current_elevenlabs_id)
        : undefined;
      const why: string[] = archiveRefusalsCheap(voice, { lossyOk: true });
      if (pin?.pinned) why.push(`pinned by ${pin.project_name}`);
      return why.length
        ? `${name} cannot be archived: ${why.join(", ")}`
        : null;
    };
    const first = await hard(row!);
    if (first) return failed(first, "nothing was spent");

    const warnings: string[] = [];
    if (m.backup) {
      await rec.record({ phase: "backing_up" });
      if (!(await snapshotValid(deps, row!))) {
        let why: string | null = null;
        try {
          const snap = await snapshotSample(deps, row!, { execute: true });
          if (!snap.executed) why = snap.refusals.join(", ");
        } catch (err) {
          why = errorMessage(err);
        }
        if (why && !m.lossy_ok)
          return failed(
            `backing up ${name} failed: ${why}`,
            "nothing was deleted",
          );
        if (why)
          warnings.push(
            `backing up ${name} failed (${why}); archived anyway, as lossy_ok allows`,
          );
      }
      let labelsWritten = false;
      if (labelsMissing(row!.labels) && !blank(row!.description)) {
        await writeVoiceLabels(sb, row!.id, minimalLabels(row!.description!));
        labelsWritten = true;
      }
      row = (await readVoice(sb, row!.id))!;
      await rec.record({
        phase: "backed_up",
        snapshot: row.source_clip_path,
        labelsWritten,
      });
    }

    const again = await hard(row!);
    if (again) return failed(again, "nothing was deleted");
    const voice = row!;
    await rec.record({
      phase: "archiving",
      archived: voice.id,
      archivedElevenLabsId: voice.current_elevenlabs_id ?? undefined,
    });
    let r;
    try {
      r = await archiveVoice(deps, voice, {
        needs: ctx.detail.needsAfter,
        execute: true,
        lossyOk: m.lossy_ok,
        archivedForBookId: ctx.bookId,
      });
    } catch (err) {
      if (err instanceof ArchiveRecordError) {
        ctx.archived.set(i, { row: voice, deleteConfirmed: true });
        await rec.record({ phase: "archived" });
        try {
          await finishArchive(sb, voice, err.formerElevenLabsId);
        } catch (finishErr) {
          return attention(
            err.message,
            `finishing the registry write failed too: ${errorMessage(finishErr)}`,
            "reconcile finishes it",
          );
        }
        return done(
          [...warnings, err.message, "the registry write was finished"],
          {
            voiceUuid: voice.id,
          },
        );
      }
      return attention(
        `archiving ${name} did not finish: ${errorMessage(err)}`,
        "the DELETE may have landed; nothing was retried",
      );
    }
    if (!r.executed)
      return failed(
        `${name} cannot be archived: ${r.refusals.join(", ")}`,
        "nothing was deleted",
      );
    ctx.archived.set(i, { row: voice, deleteConfirmed: false });
    await rec.record({ phase: "archived" });
    return done(warnings, { voiceUuid: voice.id });
  });
}

/**
 * Records a voice an add made on ElevenLabs: the restored row's new id, or
 * a designed voice's row (the character's stored design row when it has
 * one), then the cast. Safe to repeat; `reconcileRun` calls it too.
 */
export async function finishAdd(
  deps: VoiceSlotsDeps,
  scope: { bookId: string; issueId: string; rowId: string },
  m: AddMove,
  elevenLabsId: string,
  recorded: boolean,
): Promise<string> {
  const sb = deps.supabase;
  let voiceUuid: string;
  if (m.kind === "restore") {
    voiceUuid = m.voice_uuid;
    if (!recorded) {
      const row = await readVoice(sb, voiceUuid);
      if (!row) throw new Error(`no voice ${voiceUuid}`);
      if (row.current_elevenlabs_id !== elevenLabsId) {
        // Write the id only onto the state the add left: archived, no id.
        // A row restored or re-archived since then is left as it is.
        if (row.status !== "archived" || row.current_elevenlabs_id !== null)
          throw new Error(
            `${row.display_name} is ${row.status} with ${row.current_elevenlabs_id ?? "no ElevenLabs id"}, not archived as the add found it; ${elevenLabsId} was not written to it (delete it on ElevenLabs by hand if it is a duplicate)`,
          );
        await markRestored(sb, row, elevenLabsId);
      }
    }
    if (m.character_id) await fileVoiceUnder(sb, voiceUuid, m.character_id);
  } else {
    const book = await loadBookCast(sb, scope.bookId);
    voiceUuid =
      (await readVoicesByElevenLabsIds(sb, [elevenLabsId]))[0]?.id ??
      (await activateDesignedVoice(sb, {
        display_name:
          book.resolve(m.character_id)?.display_name ?? m.character_id,
        current_elevenlabs_id: elevenLabsId,
        description: m.design_prompt,
        labels: minimalLabels(m.design_prompt),
        source_clip_path: null,
        source_clip_md5: null,
        character_id: m.character_id,
        design_prompt: m.design_prompt,
      }));
    if (m.run_only) await markRunOnly(sb, voiceUuid);
    const upd = await sb
      .from("casting_moves")
      .update({ voice_uuid: voiceUuid })
      .eq("id", scope.rowId);
    fail("recording the new voice on the move", upd.error);
  }
  const characterId = m.character_id;
  if (characterId) {
    if (m.kind === "create_design" && m.run_only)
      await setIssueVoice(
        sb,
        scope.bookId,
        scope.issueId,
        characterId,
        voiceUuid,
      );
    else
      await castVoiceInBook(
        sb,
        scope.bookId,
        scope.issueId,
        characterId,
        voiceUuid,
      );
  }
  return voiceUuid;
}

async function runAdd(
  ctx: Ctx,
  i: number,
  m: AddMove,
  rowId: string,
  rec: MoveRecorder,
): Promise<Ended> {
  const { deps } = ctx;
  const sb = deps.supabase;
  const book = await loadBookCast(sb, ctx.bookId);
  let row: VoiceRow | null = null;
  let stored: VoiceRow | null = null;
  let name: string;
  if (m.kind === "restore") {
    row = await readVoice(sb, m.voice_uuid);
    if (!row) return failed(`no voice ${m.voice_uuid}`);
    name = row.display_name;
  } else {
    stored = await readStoredDesign(sb, m.character_id);
    name = book.resolve(m.character_id)?.display_name ?? m.character_id;
  }

  return withVoiceClaims(
    sb,
    [
      { row, op: "restore" },
      { row: stored, op: "design" },
    ],
    async () => {
      if (m.character_id) {
        const why = await protectedOwnVoice(
          ctx,
          m.character_id,
          m.kind === "restore" ? m.voice_uuid : null,
          m.kind === "create_design" && m.run_only ? "issue" : "later",
        );
        if (why) return failed(why, "nothing was spent");
      }
      let before: string[];
      try {
        before = (await listVoices(deps)).map((v) => v.voice_id);
      } catch (err) {
        return failed(
          `could not list the account's voices: ${errorMessage(err)}`,
        );
      }
      await rec.record({ phase: "adding", before, name });

      let added: Added;
      try {
        if (m.kind === "restore") {
          const r = await restoreVoice(deps, row!, {
            execute: true,
            opToken: rec.op.token,
          });
          added =
            r.executed && r.newElevenLabsId
              ? {
                  kind: "added",
                  elevenLabsId: r.newElevenLabsId,
                  recorded: true,
                }
              : { kind: "refused", reason: r.refusals.join(", ") };
        } else {
          const r = await createFromPreview(
            deps,
            m.generated_voice_id,
            name,
            m.design_prompt,
            { opToken: rec.op.token, meta: ctx.meta },
          );
          added = { kind: "added", elevenLabsId: r.voice_id, recorded: false };
        }
      } catch (err) {
        added = classify(err);
      }

      if (added.kind === "refused") {
        const from = ctx.detail.slotFrom.get(i);
        const freedBy = from !== undefined ? ctx.archived.get(from) : undefined;
        if (!freedBy)
          return failed(`adding ${name} was refused: ${added.reason}`);
        // The record names the archived voice and the id its DELETE took,
        // so a reconcile can finish it. The bring-back holds that voice's
        // claim so no other run restores it meanwhile: the claim this move
        // already holds when it is a restore of that same voice, else a
        // fresh one.
        await rec.record({
          archived: freedBy.row.id,
          archivedElevenLabsId: freedBy.row.current_elevenlabs_id ?? undefined,
        });
        const now = await readVoice(sb, freedBy.row.id);
        const heldHere =
          m.kind === "restore" && m.voice_uuid === freedBy.row.id;
        let back: { ok: true } | { ok: false; why: string };
        try {
          back = !now
            ? { ok: false, why: `${freedBy.row.display_name}: row not found` }
            : heldHere
              ? await bringBack(deps, rec, now, freedBy.deleteConfirmed)
              : await withVoiceClaims(sb, [{ row: now, op: "restore" }], () =>
                  bringBack(deps, rec, now, freedBy.deleteConfirmed),
                );
        } catch (err) {
          if (!(err instanceof VoiceHeldError)) throw err;
          back = {
            ok: false,
            why: `${freedBy.row.display_name} is held by another run, so it was not brought back; restore it from /admin/voices`,
          };
        }
        return back.ok
          ? failed(
              `adding ${name} was refused: ${added.reason}`,
              `${freedBy.row.display_name}, archived to make room, was brought back`,
            )
          : attention(`adding ${name} was refused: ${added.reason}`, back.why);
      }
      const warnings: string[] = [];
      if (added.kind === "uncertain") {
        const found = await matchLostAdd(deps, rec.op);
        if (!found.ok)
          return attention(
            `the add's reply was lost: ${added.reason}`,
            found.why,
            "nothing was retried and nothing more was changed",
          );
        warnings.push(
          `the add's reply was lost (${added.reason}); found the new voice ${found.id} by its token`,
        );
        added = { kind: "added", elevenLabsId: found.id, recorded: false };
      }

      const elevenLabsId = added.elevenLabsId;
      await rec.record({ phase: "added", elevenLabsId });
      try {
        const voiceUuid = await finishAdd(
          deps,
          { bookId: ctx.bookId, issueId: ctx.issueId, rowId },
          m,
          elevenLabsId,
          added.recorded,
        );
        return done(warnings, { voiceUuid, elevenLabsId });
      } catch (err) {
        return attention(
          `the voice ${elevenLabsId} exists on ElevenLabs, but recording it failed: ${errorMessage(err)}`,
          "reconcile finishes the rows",
        );
      }
    },
  );
}

/** The moves that write only the castlist or characters: no slot, no spend. */
async function runCastMove(
  ctx: Ctx,
  m: Exclude<Move, ArchiveMove | AddMove>,
  rowId: string,
): Promise<Ended> {
  const sb = ctx.deps.supabase;
  const { bookId, issueId } = ctx;
  switch (m.kind) {
    case "cast":
    case "stand_in": {
      const voice = await readVoice(sb, m.voice_uuid);
      if (!voice) return failed(`no voice ${m.voice_uuid}`);
      if (isProtectedVoice(voice) && voice.character_id !== m.character_id)
        return failed(
          `${voice.display_name} is a protected v2 voice; it speaks only for its own character`,
        );
      const why = await protectedOwnVoice(
        ctx,
        m.character_id,
        m.voice_uuid,
        m.kind === "cast" ? "later" : "issue",
      );
      if (why) return failed(why);
      if (m.kind === "cast")
        await castVoiceInBook(
          sb,
          bookId,
          issueId,
          m.character_id,
          m.voice_uuid,
        );
      else
        await setIssueVoice(sb, bookId, issueId, m.character_id, m.voice_uuid);
      return done([], { voiceUuid: m.voice_uuid });
    }
    case "sit_out":
    case "back_in":
      await setNoAudio(
        sb,
        bookId,
        issueId,
        m.character_id,
        m.kind === "sit_out",
      );
      return done();
    case "remove_character":
      await removeFromCast(sb, bookId, issueId, m.character_id);
      return done();
    case "rename":
      await renameCharacter(sb, m.character_id, m.name.trim());
      return done();
    case "add_character": {
      let id = m.character_id;
      if (!id) {
        const book = await loadBookCast(sb, bookId);
        id = book.resolve(m.name)?.id ?? null;
        if (!id) {
          id = slugify(m.name);
          const franchise = (await readBookFranchises(sb, bookId))[0];
          await createCharacter(sb, {
            id,
            displayName: m.name.trim(),
            franchiseId: franchise?.id ?? null,
          });
        }
        const upd = await sb
          .from("casting_moves")
          .update({ character_id: id })
          .eq("id", rowId);
        fail("recording the added character on the move", upd.error);
      }
      await addToCast(sb, bookId, issueId, id);
      return done();
    }
  }
}
