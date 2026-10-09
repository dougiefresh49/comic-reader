import type { SupabaseClient } from "@supabase/supabase-js";
import { slugify } from "~/lib/character-id";
import {
  loadBookCast,
  renderVoice,
  voiceFor,
  type BookCast,
  type CastRow,
  type CastVoiceRow,
} from "~/lib/cast";
import { checkSnapshot } from "~/lib/voice-slots/bucket";
import { getSlotStatus } from "~/lib/voice-slots/elevenlabs";
import { readCastlist, readVoices } from "~/lib/voice-slots/registry";
import { restoreVoice } from "~/lib/voice-slots/restore";
import {
  isProtectedVoice,
  type VoiceRow,
  type VoiceSlotsDeps,
} from "~/lib/voice-slots/types";
import { ROOM_CONSUMER } from "~/lib/voice-slots/archive";
import { readSpeakerLines } from "~/workflows/steps/casting-tasks";
import {
  holdsSlot,
  readAccountOwners,
  readAccountVoices,
  type AccountVoice,
  type AccountVoiceOwner,
} from "./account";
import { blank, labelsMissing } from "./labels";
import type {
  ArchiveMove,
  BackupPlan,
  Blocker,
  BlockerCode,
  Move,
  MoveKind,
  MovesPlan,
  PlanStep,
} from "./types";

const KINDS: ReadonlySet<MoveKind> = new Set<MoveKind>([
  "archive",
  "restore",
  "create_design",
  "cast",
  "stand_in",
  "sit_out",
  "back_in",
  "add_character",
  "remove_character",
  "rename",
]);

export const isAddMove = (m: Move) =>
  m.kind === "restore" || m.kind === "create_design";

const str = (v: unknown): v is string => typeof v === "string" && v !== "";

/** The shape check a move from the client gets before anything reads it; null when it is well formed. */
export function moveShapeError(m: unknown): string | null {
  if (!m || typeof m !== "object") return "not a move";
  const move = m as Record<string, unknown>;
  if (!KINDS.has(move.kind as MoveKind))
    return `unknown kind ${String(move.kind)}`;
  const need = (...keys: string[]) => {
    const missing = keys.filter((k) => !str(move[k]));
    return missing.length
      ? `${String(move.kind)}: missing ${missing.join(", ")}`
      : null;
  };
  switch (move.kind as MoveKind) {
    case "archive":
      if (!str(move.voice_uuid) && !str(move.elevenlabs_id))
        return "archive: names no voice_uuid or elevenlabs_id";
      if (
        typeof move.backup !== "boolean" ||
        typeof move.lossy_ok !== "boolean"
      )
        return "archive: backup and lossy_ok must be true or false";
      return null;
    case "restore":
      return need("voice_uuid");
    case "create_design":
      if (typeof move.run_only !== "boolean")
        return "create_design: run_only must be true or false";
      return need(
        "character_id",
        "generated_voice_id",
        "design_prompt",
        "preview_text",
      );
    case "cast":
    case "stand_in":
      return need("character_id", "voice_uuid");
    case "add_character":
      return str(move.character_id) || str(move.name)
        ? null
        : "add_character: names no character_id or name";
    case "rename":
      return need("character_id", "name");
    default:
      return need("character_id");
  }
}

/** What the run needs from the plan beyond what Review shows. */
export interface PlanDetail {
  plan: MovesPlan;
  /** Move indexes in run order. */
  order: number[];
  /**
   * `voices.id` the issue's speakers render with once every move ran, the
   * archive guard's "needed by issue" set. A voice this plan restores is left
   * out, so an archive and a restore of the same voice can both run.
   */
  needsAfter: Set<string>;
  /** Add move index to the archive move whose slot it takes. */
  slotFrom: Map<number, number>;
  /** Archive move index to the account voice it names by ElevenLabs id (no `voices` row). */
  outside: Map<number, AccountVoice>;
  owners: Map<string, AccountVoiceOwner>;
}

/** Which castlist rows a cast writes: this issue's, or this issue's and the book's later issues' (`castVoiceInBook`). */
export type CastScope = "issue" | "later";

/**
 * Why casting `to` for the character would replace one of the owner's v2
 * voices, or null. It reads every castlist row of the character the cast
 * writes (this issue's, and for `later` the book's later issues'), whatever
 * their `no_audio` or `in_issue`, and the voice the render chain lends the
 * issue when its own row holds none.
 */
export function castAwayReason(
  book: BookCast,
  protectedName: (voiceUuid: string) => string | null,
  characterId: string,
  issueId: string,
  scope: CastScope,
  to: string | null,
): string | null {
  const here = book.issueNumber.get(issueId) ?? 0;
  const held = book.rows
    .filter(
      (r) =>
        r.character_id === characterId &&
        (r.issue_id === issueId ||
          (scope === "later" &&
            (book.issueNumber.get(r.issue_id) ?? 0) > here)),
    )
    .flatMap((r) => (r.voice_uuid ? [r.voice_uuid] : []));
  const lent = voiceFor(book, characterId, issueId);
  if (lent?.from === characterId) held.push(lent.voiceUuid);
  for (const uuid of held) {
    if (uuid === to) continue;
    const name = protectedName(uuid);
    if (name)
      return `${name} is a protected v2 voice; ${characterId}'s cast in it is never replaced`;
  }
  return null;
}

/**
 * The voices (by `voices.id`, by ElevenLabs id, and `design:<character>`
 * for a design) that an earlier run's move left unresolved: `needs_attention`,
 * or `pending` with an operation record (a run in flight, or one that
 * crashed). A new move on any of them is refused until `reconcileRun`
 * settles it, so a lost add is never made twice.
 */
export async function readUnresolvedMoves(
  supabase: SupabaseClient,
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("casting_moves")
    .select("run_id, seq, kind, character_id, voice_uuid, status, operation")
    .or(
      "status.eq.needs_attention,and(status.eq.pending,operation.not.is.null)",
    );
  if (error)
    throw new Error(
      `casting moves: reading unresolved moves: ${error.message}`,
    );
  const out = new Map<string, string>();
  for (const r of (data ?? []) as {
    run_id: string;
    seq: number;
    kind: string;
    character_id: string | null;
    voice_uuid: string | null;
    status: string;
    operation: {
      phase?: string;
      archived?: string;
      archivedElevenLabsId?: string;
    } | null;
  }[]) {
    const op = r.operation;
    const why = `an earlier ${r.kind} (run ${r.run_id}, move ${r.seq + 1}) ${r.status === "pending" ? "is still open" : "needs attention"}${op?.phase ? ` at ${op.phase}` : ""}; settle it with reconcileRun("${r.run_id}") first`;
    for (const key of [
      r.voice_uuid,
      op?.archived,
      op?.archivedElevenLabsId,
      r.kind === "create_design" && r.character_id
        ? `design:${r.character_id}`
        : null,
    ])
      if (key && !out.has(key)) out.set(key, why);
  }
  return out;
}

/** True when the row's bucket copy is there and matches; any manifest problem reads as no snapshot. */
export async function snapshotValid(
  deps: VoiceSlotsDeps,
  row: VoiceRow,
): Promise<boolean> {
  if (!row.source_clip_path || !row.source_clip_md5) return false;
  try {
    return (await checkSnapshot(deps.supabase, row)).status === "ok";
  } catch {
    return false;
  }
}

/**
 * Plans the staged moves for one issue (#786). Read-only: SELECTs, Storage
 * downloads to hash-check bucket copies, and the free ElevenLabs GETs (the
 * slot count, and the account's voices when a move names one by its
 * ElevenLabs id). Returns the steps in run order, the slots before and
 * after, credits, add/edit headroom, and the blockers. Any blocker makes
 * `runMoves` refuse before it writes a row.
 *
 * Run order: Doug's staged order, except that an add with no free slot
 * waits for an archive: the next archive staged after it (with its backup
 * step) is pulled in front of it. An archive with `backup` is two steps, its
 * backup and then the archive.
 */
export async function planMoves(
  deps: VoiceSlotsDeps,
  bookId: string,
  issueId: string,
  moves: Move[],
): Promise<MovesPlan> {
  return (await planMovesDetail(deps, bookId, issueId, moves)).plan;
}

export async function planMovesDetail(
  deps: VoiceSlotsDeps,
  bookId: string,
  issueId: string,
  moves: Move[],
): Promise<PlanDetail> {
  const sb = deps.supabase;
  const needAccount = moves.some(
    (m) => m?.kind === "archive" && !m.voice_uuid && m.elevenlabs_id,
  );
  const [status, voices, book, lines, owners, castlist, account, unresolved] =
    await Promise.all([
      getSlotStatus(deps),
      readVoices(sb),
      loadBookCast(sb, bookId),
      readSpeakerLines(sb, bookId, issueId),
      readAccountOwners(sb),
      readCastlist(sb),
      needAccount ? readAccountVoices(deps) : Promise.resolve(null),
      readUnresolvedMoves(sb),
    ]);
  if (!book.issueNumber.has(issueId))
    throw new Error(`casting moves: no issue ${bookId}/${issueId}`);

  const rowById = new Map(voices.map((v) => [v.id, v]));
  const rowByElevenLabsId = new Map(
    voices
      .filter((v) => v.status === "active" && v.current_elevenlabs_id)
      .map((v) => [v.current_elevenlabs_id!, v]),
  );
  const accountById = new Map((account ?? []).map((a) => [a.voice_id, a]));
  /** Characters an `add_character` earlier in this plan creates, by id. */
  const newCharacters = new Map<string, string>();
  const charName = (id: string) =>
    newCharacters.get(id) ?? book.resolve(id)?.display_name ?? id;
  const isCharacter = (id: string) =>
    newCharacters.has(id) || book.resolve(id)?.id === id;

  // The cast as it will be: a copy of the book's rows and voice states that
  // each placed move changes, read by the render chain at the end.
  const rows: CastRow[] = book.rows.map((r) => ({ ...r }));
  const states = new Map<string, CastVoiceRow>(book.voices);
  for (const v of voices)
    if (!states.has(v.id))
      states.set(v.id, {
        id: v.id,
        current_elevenlabs_id: v.current_elevenlabs_id,
        status: v.status,
      });
  const sim: BookCast = { ...book, rows, voices: states };
  const thisNumber = book.issueNumber.get(issueId) ?? 0;
  const setVoiceIn = (
    characterId: string,
    voiceUuid: string,
    scope: "later" | "issue",
  ) => {
    const here = rows.find(
      (r) => r.issue_id === issueId && r.character_id === characterId,
    );
    if (here) here.voice_uuid = voiceUuid;
    else
      rows.push({
        issue_id: issueId,
        character_id: characterId,
        display_name: charName(characterId),
        voice_uuid: voiceUuid,
        in_issue: true,
        no_audio: false,
      });
    if (scope === "issue") return;
    for (const r of rows)
      if (
        r.character_id === characterId &&
        (book.issueNumber.get(r.issue_id) ?? 0) > thisNumber
      )
        r.voice_uuid = voiceUuid;
  };
  const patchRow = (characterId: string, patch: Partial<CastRow>) => {
    const here = rows.find(
      (r) => r.issue_id === issueId && r.character_id === characterId,
    );
    if (here) Object.assign(here, patch);
    else
      rows.push({
        issue_id: issueId,
        character_id: characterId,
        display_name: charName(characterId),
        voice_uuid: null,
        in_issue: true,
        no_audio: false,
        ...patch,
      });
  };
  const setState = (id: string, status: string, elevenLabsId: string | null) =>
    states.set(id, { id, status, current_elevenlabs_id: elevenLabsId });

  const blockers: Blocker[] = [];
  const block = (moveIndex: number | null, code: BlockerCode, reason: string) =>
    blockers.push({ moveIndex, code, reason });

  const protectedName = (uuid: string) => {
    const row = rowById.get(uuid);
    return row && isProtectedVoice(row) ? row.display_name : null;
  };
  /** Cast-away (#786 decision 5): see `castAwayReason`. */
  const castAway = (
    i: number,
    characterId: string,
    to: string | null,
    scope: CastScope,
  ) => {
    const why = castAwayReason(
      sim,
      protectedName,
      characterId,
      issueId,
      scope,
      to,
    );
    if (why) block(i, "protected", why);
  };
  /** A move on a voice an earlier run left unresolved. */
  const unsettled = (i: number, ...keys: (string | null | undefined)[]) => {
    for (const key of keys) {
      const why = key ? unresolved.get(key) : undefined;
      if (why) {
        block(i, "unresolved", why);
        return;
      }
    }
  };
  const replacesProtected = (
    i: number,
    m: { replaces_voice_uuid?: string | null },
  ) => {
    const row = m.replaces_voice_uuid
      ? rowById.get(m.replaces_voice_uuid)
      : null;
    if (row && isProtectedVoice(row))
      block(
        i,
        "protected",
        `${row.display_name} is a protected v2 voice; it is never replaced`,
      );
  };

  const steps: PlanStep[] = [];
  const order: number[] = [];
  const placed = new Set<number>();
  const slotFrom = new Map<number, number>();
  const outside = new Map<number, AccountVoice>();
  /** Voices archived by this plan, with whether they can come back. */
  const archivedHere = new Map<string, { moveIndex: number; lossy: boolean }>();
  /** Other projects' ElevenLabs ids archived by this plan, to the archive move. */
  const archivedOutside = new Map<string, number>();
  /** Voices this plan restores: the archive guard's "needed" set leaves them out. */
  const restoredHere = new Set<string>();
  let pristineFree = Math.max(0, status.voice_limit - status.voice_slots_used);
  const freed: number[] = [];
  let adds = 0;
  let archives = 0;

  const step = (
    moveIndex: number,
    kind: PlanStep["kind"],
    label: string,
    extra: Partial<PlanStep> = {},
  ) =>
    steps.push({
      seq: steps.length,
      moveIndex,
      kind,
      label,
      voiceUuid: null,
      characterId: null,
      slot: null,
      slotFromMove: null,
      backup: null,
      warnings: [],
      ...extra,
    });

  const placeArchive = async (i: number, m: ArchiveMove) => {
    placed.add(i);
    order.push(i);
    const bad = moveShapeError(m);
    if (bad) {
      block(i, "invalid", bad);
      return;
    }
    let row = m.voice_uuid ? rowById.get(m.voice_uuid) : undefined;
    let acct: AccountVoice | undefined;
    if (!row && m.elevenlabs_id) {
      row = rowByElevenLabsId.get(m.elevenlabs_id);
      if (!row) acct = accountById.get(m.elevenlabs_id);
    }
    const name =
      row?.display_name ?? acct?.name ?? m.voice_uuid ?? m.elevenlabs_id ?? "?";
    const elevenLabsId = row?.current_elevenlabs_id ?? m.elevenlabs_id ?? null;
    const owner = elevenLabsId ? owners.get(elevenLabsId) : undefined;
    if (owner?.pinned)
      block(i, "pinned", `${name} is pinned by ${owner.project_name}`);
    if (!row && !acct) {
      block(i, "invalid", `no voice ${name} here or on the account`);
      step(i, "archive", `Archive ${name}`);
      return;
    }
    const earlier = acct ? archivedOutside.get(acct.voice_id) : undefined;
    if (
      (row && states.get(row.id)?.status !== "active") ||
      earlier !== undefined
    ) {
      block(
        i,
        "invalid",
        earlier !== undefined
          ? `${name} is already archived by move ${earlier + 1}`
          : `${name} is not active, so there is no slot to free`,
      );
      step(i, "archive", `Archive ${name}`, { voiceUuid: row?.id ?? null });
      return;
    }
    unsettled(i, row?.id, elevenLabsId);
    const hardBefore = blockers.length;
    if (row && isProtectedVoice(row))
      block(
        i,
        "protected",
        `${name} is a protected v2 voice; it is never archived`,
      );
    if (row?.consumers.includes(ROOM_CONSUMER))
      block(i, "room", `${name} is used by the room app`);
    if (row?.keep_active)
      block(i, "keep_active", `${name} is marked keep active`);

    const hard = blockers.length > hardBefore || Boolean(owner?.pinned);
    const description = row ? row.description : (acct?.description ?? null);
    const snapOk = row ? await snapshotValid(deps, row) : false;
    const labelsOk = !labelsMissing(row ? row.labels : (acct?.labels ?? null));
    const descOk = !blank(description);
    const lossy = !(descOk && (snapOk || m.backup) && (labelsOk || m.backup));
    const backup: BackupPlan = {
      snapshot: m.backup && !snapOk && Boolean(elevenLabsId),
      labels: m.backup && !labelsOk && descOk,
      lossy,
    };
    if (lossy && !m.lossy_ok)
      block(
        i,
        "lossy",
        !descOk
          ? `${name} has no description, so it could not come back after the archive; archive anyway to lose it`
          : `backup is off and ${name} has no ${snapOk ? "labels" : "snapshot"}, so it could not come back; back it up first or archive anyway`,
      );
    if (acct) outside.set(i, acct);

    const warnings: string[] = [];
    if (row) {
      const elsewhere = castlist.filter(
        (c) =>
          c.voice_uuid === row.id &&
          !(c.book_id === bookId && c.issue_id === issueId),
      );
      for (const c of elsewhere.slice(0, 5))
        warnings.push(
          `${c.display_name} in ${c.book_id}/${c.issue_id} is cast with it`,
        );
      if (elsewhere.length > 5)
        warnings.push(`and ${elsewhere.length - 5} more castlist rows`);
    }
    if (m.backup)
      step(i, "backup", `Back up ${name}`, {
        voiceUuid: row?.id ?? null,
        backup,
      });
    const frees = row ? true : acct ? holdsSlot(acct) : false;
    step(i, "archive", `Archive ${name}`, {
      voiceUuid: row?.id ?? null,
      slot: frees ? "frees" : null,
      backup,
      warnings,
    });
    // A hard refusal never runs: the cast and the slots stay as they are.
    if (hard) return;
    if (row) {
      setState(row.id, "archived", null);
      archivedHere.set(row.id, { moveIndex: i, lossy });
    }
    if (acct) archivedOutside.set(acct.voice_id, i);
    if (frees) {
      freed.push(i);
      archives++;
    }
  };

  /** Takes a slot for add move `i`: a free one first, then one an archive placed earlier freed, then the next archive staged later. */
  const takeSlot = async (
    i: number,
  ): Promise<Pick<PlanStep, "slot" | "slotFromMove">> => {
    if (pristineFree > 0) {
      pristineFree--;
      return { slot: "free", slotFromMove: null };
    }
    if (freed.length === 0) {
      const next = moves.findIndex(
        (m, j) => j > i && !placed.has(j) && m?.kind === "archive",
      );
      if (next >= 0) await placeArchive(next, moves[next] as ArchiveMove);
    }
    const from = freed.shift();
    if (from === undefined) return { slot: null, slotFromMove: null };
    slotFrom.set(i, from);
    return { slot: "freed", slotFromMove: from };
  };

  /** Places a move that is not an archive. */
  const placeOther = async (i: number, m: Exclude<Move, ArchiveMove>) => {
    placed.add(i);
    const characterId = "character_id" in m ? m.character_id : null;
    if (
      characterId &&
      m.kind !== "add_character" &&
      !isCharacter(characterId)
    ) {
      order.push(i);
      block(i, "invalid", `no character ${characterId}`);
      step(i, m.kind, `${m.kind} ${characterId}`, { characterId });
      return;
    }

    switch (m.kind) {
      case "restore": {
        const row = rowById.get(m.voice_uuid);
        const name = row?.display_name ?? m.voice_uuid;
        const label = `Bring back ${name}${m.character_id ? ` for ${charName(m.character_id)}` : ""}`;
        const here = row ? archivedHere.get(row.id) : undefined;
        const slot = await takeSlot(i);
        order.push(i);
        if (!row) block(i, "invalid", `no voice ${m.voice_uuid}`);
        else if (here?.lossy)
          block(
            i,
            "not_restorable",
            `${name} is archived by this plan with nothing kept, so it cannot come back`,
          );
        else if (!here && states.get(row.id)?.status !== "archived")
          block(
            i,
            "invalid",
            `${name} is ${states.get(row.id)?.status ?? row.status}, not archived`,
          );
        else if (!here) {
          const check = await restoreVoice(deps, row);
          if (check.refusals.length > 0)
            block(
              i,
              "not_restorable",
              `${name} cannot come back: ${check.refusals.join(", ")}`,
            );
        }
        if (!slot.slot)
          block(
            i,
            "no_slot",
            `no free slot for ${name}; archive a voice to make room`,
          );
        unsettled(i, m.voice_uuid);
        restoredHere.add(m.voice_uuid);
        if (m.character_id) {
          replacesProtected(i, m);
          castAway(i, m.character_id, m.voice_uuid, "later");
        }
        if (row)
          setState(row.id, "active", row.current_elevenlabs_id ?? "restored");
        if (row && m.character_id) setVoiceIn(m.character_id, row.id, "later");
        adds++;
        step(i, "restore", label, {
          voiceUuid: m.voice_uuid,
          characterId: m.character_id,
          ...slot,
        });
        break;
      }
      case "create_design": {
        const name = charName(m.character_id);
        const slot = await takeSlot(i);
        order.push(i);
        if (blank(m.design_prompt))
          block(i, "invalid", `${name}'s design has no prompt`);
        if (!slot.slot)
          block(
            i,
            "no_slot",
            `no free slot for ${name}'s new voice; archive a voice to make room`,
          );
        unsettled(i, `design:${m.character_id}`);
        replacesProtected(i, m);
        castAway(i, m.character_id, null, m.run_only ? "issue" : "later");
        const key = `design:${i}`;
        setState(key, "active", key);
        setVoiceIn(m.character_id, key, m.run_only ? "issue" : "later");
        adds++;
        step(
          i,
          "create_design",
          `Create ${name}'s voice${m.run_only ? " (this run only)" : ""}`,
          { characterId: m.character_id, ...slot },
        );
        break;
      }
      case "cast":
      case "stand_in": {
        order.push(i);
        const row = rowById.get(m.voice_uuid);
        const name = charName(m.character_id);
        if (!row) block(i, "invalid", `no voice ${m.voice_uuid}`);
        else if (isProtectedVoice(row) && row.character_id !== m.character_id)
          block(
            i,
            "protected",
            `${row.display_name} is a protected v2 voice; it speaks only for its own character`,
          );
        unsettled(i, m.voice_uuid);
        replacesProtected(i, m);
        castAway(
          i,
          m.character_id,
          m.voice_uuid,
          m.kind === "cast" ? "later" : "issue",
        );
        setVoiceIn(
          m.character_id,
          m.voice_uuid,
          m.kind === "cast" ? "later" : "issue",
        );
        step(
          i,
          m.kind,
          m.kind === "cast"
            ? `Cast ${row?.display_name ?? m.voice_uuid} for ${name}`
            : `${name} as ${row?.display_name ?? m.voice_uuid}, this issue`,
          { voiceUuid: m.voice_uuid, characterId: m.character_id },
        );
        break;
      }
      case "sit_out":
        order.push(i);
        patchRow(m.character_id, { no_audio: true });
        step(i, "sit_out", `Sit out ${charName(m.character_id)}`, {
          characterId: m.character_id,
          warnings: lines.has(m.character_id)
            ? [`${lines.get(m.character_id)!.length} line(s) stay silent`]
            : [],
        });
        break;
      case "back_in":
        order.push(i);
        patchRow(m.character_id, { no_audio: false });
        step(i, "back_in", `Back in: ${charName(m.character_id)}`, {
          characterId: m.character_id,
        });
        break;
      case "remove_character":
        order.push(i);
        patchRow(m.character_id, { in_issue: false });
        step(
          i,
          "remove_character",
          `Not in this issue: ${charName(m.character_id)}`,
          {
            characterId: m.character_id,
          },
        );
        break;
      case "add_character": {
        order.push(i);
        const id = m.character_id ?? book.resolve(m.name)?.id ?? null;
        if (m.character_id && !isCharacter(m.character_id))
          block(i, "invalid", `no character ${m.character_id}`);
        else if (!id && !slugify(m.name))
          block(i, "invalid", `"${m.name}" makes no character id`);
        if (!id && slugify(m.name))
          newCharacters.set(slugify(m.name), m.name.trim());
        if (id && isCharacter(id)) patchRow(id, { in_issue: true });
        step(
          i,
          "add_character",
          `Add ${id ? charName(id) : m.name.trim()}${id ? "" : " (new)"} to the cast`,
          { characterId: id ?? slugify(m.name) },
        );
        break;
      }
      case "rename":
        order.push(i);
        if (blank(m.name)) block(i, "invalid", "a rename needs a name");
        step(
          i,
          "rename",
          `Rename ${charName(m.character_id)} → ${m.name.trim()}`,
          {
            characterId: m.character_id,
          },
        );
        break;
    }
  };

  /** An add that may run before an archive: not a restore of a voice an archive still to be placed frees. */
  const canGoFirst = (j: number) => {
    const mj = moves[j];
    if (!mj || moveShapeError(mj) || !isAddMove(mj)) return false;
    return !(
      mj.kind === "restore" &&
      moves.some(
        (mk, k) =>
          !placed.has(k) &&
          mk?.kind === "archive" &&
          mk.voice_uuid === mj.voice_uuid,
      )
    );
  };

  for (let i = 0; i < moves.length; i++) {
    if (placed.has(i)) continue;
    const m = moves[i]!;
    const bad = moveShapeError(m);
    if (bad) {
      placed.add(i);
      order.push(i);
      block(i, "invalid", bad);
      continue;
    }
    if (m.kind === "archive") {
      // Add first while a slot is free, as `carryOut` does: a refused add
      // stops the run before this archive deletes anything.
      for (let j = i + 1; pristineFree > 0 && j < moves.length; j++)
        if (!placed.has(j) && canGoFirst(j))
          await placeOther(j, moves[j] as Exclude<Move, ArchiveMove>);
      await placeArchive(i, m);
      continue;
    }
    await placeOther(i, m);
  }

  // Speakers after every move: each must render, sit out, or be removed.
  const needsAfter = new Set<string>();
  for (const [id, list] of lines) {
    const r = renderVoice(sim, id, issueId);
    if (r.ok) {
      if (rowById.has(r.voiceUuid)) needsAfter.add(r.voiceUuid);
      continue;
    }
    if (r.reason !== "no voice" && r.reason !== "not in a slot") continue;
    const culprit =
      (r.voice ? archivedHere.get(r.voice.voiceUuid)?.moveIndex : undefined) ??
      [...moves.keys()].reverse().find((j) => {
        const mj = moves[j];
        return (
          mj &&
          "character_id" in mj &&
          mj.character_id === id &&
          (mj.kind === "cast" || mj.kind === "stand_in")
        );
      }) ??
      null;
    block(
      culprit,
      "unvoiced_speaker",
      `${charName(id)} has ${list.length} line(s) here and ${r.reason === "no voice" ? "no voice" : "a voice that is not in a slot"} after these moves; give them a voice or sit them out`,
    );
  }

  const left = status.max_voice_add_edits - status.voice_add_edit_counter;
  if (adds > left)
    block(
      null,
      "headroom",
      `${adds} add(s) planned and ${left} add/edit(s) left this month`,
    );

  blockers.sort(
    (a, b) => (a.moveIndex ?? Infinity) - (b.moveIndex ?? Infinity),
  );
  return {
    plan: {
      bookId,
      issueId,
      steps,
      slots: {
        before: status.voice_slots_used,
        after: status.voice_slots_used + adds - archives,
        limit: status.voice_limit,
      },
      credits: {
        run: 0,
        previews: moves.reduce(
          (n, m) =>
            n +
            (m?.kind === "create_design" ? (m.preview_text ?? "").length : 0),
          0,
        ),
      },
      headroom: { left, adds },
      blockers,
    },
    order,
    needsAfter: new Set([...needsAfter].filter((v) => !restoredHere.has(v))),
    slotFrom,
    outside,
    owners,
  };
}
