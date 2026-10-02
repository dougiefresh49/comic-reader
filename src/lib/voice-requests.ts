/**
 * The voice work library (#351): one issue's voice work (every voice request
 * and every speaker with no voice) planned together against the account's
 * slots, and carried out one item at a time on the owner's click.
 *
 * The two slot-plan rules are #351's: the whole list is planned together,
 * each slot-taking item with its own outgoing voice; and a replacement's
 * outgoing voice defaults to the voice it replaces (add first when a slot is
 * free, else archive first, restore the old voice when the add is refused,
 * look the voice up on ElevenLabs when an add's reply is lost).
 *
 * Every ElevenLabs request goes through `src/lib/voice-slots`; every castlist
 * write goes through `src/lib/cast.ts`. Functions take `VoiceSlotsDeps`
 * (the Supabase client, and a fake `fetch` for a scratch run) or the client.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addToCast,
  loadBookCast,
  readVoiceRequests,
  setVoice,
  voiceFor,
  type BookCast,
  type CastRow,
} from "~/lib/cast";
import { slugify } from "~/lib/character-id";
import { SKIPPED_VOICE } from "~/lib/voice-settings";
import {
  ArchiveRecordError,
  ElevenLabsHeadroomError,
  ElevenLabsRefusedError,
  archiveRefusals,
  archiveVoice,
  designVoice,
  findOpVoices,
  issueNeeds,
  listVoices,
  markRestored,
  planFreeSlots,
  readCastlist,
  readVoice,
  readVoices,
  registerVoice,
  restoreVoice,
  withVoiceOperationClaim,
  type SlotStatus,
  type VoiceRow,
  type VoiceSlotsDeps,
} from "~/lib/voice-slots";
import {
  buildAliasMap,
  speakerKey,
  voiceDesignAppearanceId,
} from "~/workflows/steps/audio-plan";
import { describeVoices, skippedIn } from "~/workflows/steps/voice";

export type VoiceWorkAction = "clone" | "design" | "restore";

/** Why the item is on the list. */
export type VoiceWorkSource =
  /** A `casting_tasks` row with an `action`, recorded at the characters stop. */
  | "request"
  /** A speaker in the issue with no voice and no skip. */
  | "no voice"
  /** A speaker whose castlist voice is archived. */
  | "archived voice";

/**
 * `made`: the voice exists, waiting on `settle`. `needs attention`: a
 * `carryOut` is in flight or stopped uncertain; see `operation`.
 */
export type VoiceWorkState = "pending" | "made" | "settled" | "needs attention";

/** The voice an item that takes a slot gives back, or the free slot it uses. */
export type Outgoing =
  | { kind: "free slot" }
  | {
      kind: "archive";
      voice: VoiceRow;
      /** A replacement adds first when a slot is free, else archives first. */
      order: "add first" | "archive first";
      /** Why this voice cannot be archived; empty when it can. */
      refusals: string[];
      /** Castlist rows in any book that the archive would leave without a voice. */
      leavesWithoutVoice: {
        bookId: string;
        issueId: string;
        character: string;
      }[];
    };

export interface VoiceWorkItem {
  bookId: string;
  issueId: string;
  /** A `characters.id`; also the item's key. */
  characterId: string;
  name: string;
  source: VoiceWorkSource;
  action: VoiceWorkAction;
  state: VoiceWorkState;
  /** The `carryOut` recorded on the item's task row, when one is. */
  operation: OpRecord | null;
  /** Clone or restore: the archived `voices` row that comes back. */
  target: VoiceRow | null;
  /** The character's own active voice, which a clone or design replaces. */
  replaces: VoiceRow | null;
  /** voice-lab clones filed under the character, `lab_default` first. */
  candidates: { id: string; name: string; labDefault: boolean }[];
  /** The character's non-ignored, non-silent bubbles in the issue. */
  lines: number;
  /** Design: a description is stored on `<id>-voice-design`. */
  hasDescription: boolean;
  /** Pending, not refused: counted in the slot plan. */
  needsSlot: boolean;
  outgoing: Outgoing | null;
  /** Why the item cannot run, whatever voice is archived for it. */
  refusals: string[];
  warnings: string[];
}

export interface VoiceWorkPlan {
  bookId: string;
  issueId: string;
  /** The live slot count, the one ElevenLabs call the plan makes. */
  status: SlotStatus;
  freeNow: number;
  addEditHeadroom: number;
  /** One add per item that takes a slot. */
  adds: number;
  /** Items whose outgoing voice is archived (replacements included). */
  archives: number;
  items: VoiceWorkItem[];
  /** True when every pending item can run as planned. */
  ok: boolean;
  refusals: string[];
  /** Other voices the policy could archive: the "pick a different voice" list. */
  spare: VoiceRow[];
  refusedVoices: { voice: VoiceRow; refusals: string[] }[];
  /** Items not settled; Continue is refused while this is above zero. */
  unsettled: number;
}

const PAGE = 1000;

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`voice work: ${what}: ${error.message}`);
}

/** The character a castlist row belongs to, as `cast.ts` reads it. */
function rowCharacter(
  book: BookCast,
  r: Pick<CastRow, "character" | "character_id">,
) {
  return (
    r.character_id ?? book.resolve(r.character)?.id ?? slugify(r.character)
  );
}

/** Lines per character in the issue: `bubbles.character_id`, else the speaker through the aliases. */
async function readLines(
  client: SupabaseClient,
  book: BookCast,
  bookId: string,
  issueId: string,
): Promise<Map<string, number>> {
  const aliasRes = await client
    .from("aliases")
    .select("alias, canonical")
    .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`);
  fail("reading aliases", aliasRes.error);
  const aliasMap = buildAliasMap(
    (aliasRes.data ?? []) as { alias: string; canonical: string }[],
  );
  const lines = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("bubbles")
      .select("character_id, speaker")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("ignored", false)
      .eq("silent", false)
      .order("id")
      .range(from, from + PAGE - 1);
    fail("reading bubbles", error);
    const page = (data ?? []) as {
      character_id: string | null;
      speaker: string | null;
    }[];
    for (const b of page) {
      const key =
        b.character_id ??
        (b.speaker?.trim() ? speakerKey(b.speaker, aliasMap) : null);
      if (!key) continue;
      const id = book.resolve(key)?.id ?? key;
      lines.set(id, (lines.get(id) ?? 0) + 1);
    }
    if (page.length < PAGE) return lines;
  }
}

async function readTasks(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<Map<string, string>> {
  const { data, error } = await client
    .from("casting_tasks")
    .select("character_id, status")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);
  fail("reading casting tasks", error);
  return new Map(
    ((data ?? []) as { character_id: string; status: string }[]).map((t) => [
      t.character_id,
      t.status,
    ]),
  );
}

async function readDescriptions(
  client: SupabaseClient,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await client
    .from("character_appearances")
    .select("id, voice_description")
    .in("id", ids.map(voiceDesignAppearanceId));
  fail("reading voice descriptions", error);
  const out = new Map<string, string>();
  for (const r of (data ?? []) as {
    id: string;
    voice_description: string | null;
  }[]) {
    const text = r.voice_description?.trim();
    if (text) out.set(r.id, text);
  }
  return out;
}

/**
 * A `carryOut` in flight, kept in `casting_tasks.status` as `op:<json>` (no
 * new column): the claim's token, the last phase reached, and what
 * `reconcile` needs. Phases: `claimed` (nothing spent on ElevenLabs),
 * `archiving` (DELETE sent), `archived` (DELETE confirmed), `adding` (add
 * sent, `before` and `name` recorded), `added` (ElevenLabs id known).
 */
export interface OpRecord {
  token: string;
  phase: "claimed" | "archiving" | "archived" | "adding" | "added";
  /** `voices.id` archived for the item. */
  archived?: string;
  /** ElevenLabs ids on the account before the add. */
  before?: string[];
  /** The name the add used. */
  name?: string;
  elevenLabsId?: string;
}

const OP_PREFIX = "op:";
const encodeOp = (op: OpRecord) => OP_PREFIX + JSON.stringify(op);

export function decodeOp(status: string | undefined): OpRecord | null {
  if (!status?.startsWith(OP_PREFIX)) return null;
  try {
    return JSON.parse(status.slice(OP_PREFIX.length)) as OpRecord;
  } catch {
    // Unreadable is still in flight: never treat it as pending.
    return { token: "", phase: "adding" };
  }
}

function stateOf(status: string | undefined): VoiceWorkState {
  if (decodeOp(status)) return "needs attention";
  if (status === "in_progress") return "made";
  if (status === "complete" || status === "skipped") return "settled";
  return "pending";
}

/**
 * The issue's voice work with the slot plan for the whole list. Reads only:
 * SELECTs, Storage downloads to hash-check bucket copies, and one free
 * ElevenLabs GET for the slot count.
 */
export async function planVoiceWork(
  deps: VoiceSlotsDeps,
  bookId: string,
  issueId: string,
): Promise<VoiceWorkPlan> {
  const sb = deps.supabase;
  const [book, requests, tasks, voices, castlist, needs] = await Promise.all([
    loadBookCast(sb, bookId),
    readVoiceRequests(sb, bookId, issueId),
    readTasks(sb, bookId, issueId),
    readVoices(sb),
    readCastlist(sb),
    issueNeeds(sb, { bookId, issueId }),
  ]);
  const lines = await readLines(sb, book, bookId, issueId);
  const voiceById = new Map(voices.map((v) => [v.id, v]));
  const { data: labRows, error: labErr } = await sb
    .from("voices")
    .select("id, character_id, lab_default")
    .eq("status", "archived")
    .not("character_id", "is", null);
  fail("reading voice-lab candidates", labErr);
  const candidatesOf = new Map<string, VoiceWorkItem["candidates"]>();
  for (const r of (labRows ?? []) as {
    id: string;
    character_id: string;
    lab_default: boolean | null;
  }[]) {
    const v = voiceById.get(r.id);
    if (!v) continue;
    const list = candidatesOf.get(r.character_id) ?? [];
    list.push({
      id: v.id,
      name: v.display_name,
      labDefault: Boolean(r.lab_default),
    });
    candidatesOf.set(r.character_id, list);
  }
  for (const list of candidatesOf.values())
    list.sort(
      (a, b) =>
        Number(b.labDefault) - Number(a.labDefault) ||
        a.name.localeCompare(b.name),
    );

  const ownActive = (id: string): VoiceRow | null => {
    const own = voiceFor(book, id, issueId);
    if (!own?.voiceUuid || own.from !== id) return null;
    const row = voiceById.get(own.voiceUuid);
    return row?.status === "active" ? row : null;
  };
  const base = (id: string) => ({
    bookId,
    issueId,
    characterId: id,
    name: book.resolve(id)?.display_name ?? id,
    candidates: candidatesOf.get(id) ?? [],
    lines: lines.get(id) ?? 0,
    hasDescription: false,
    needsSlot: false,
    outgoing: null,
    refusals: [] as string[],
    warnings: [] as string[],
  });

  const items: VoiceWorkItem[] = [];
  const seen = new Set<string>();
  for (const r of requests) {
    seen.add(r.characterId);
    items.push({
      ...base(r.characterId),
      source: "request",
      action: r.action,
      state: stateOf(r.status),
      operation: decodeOp(r.status),
      target:
        r.action === "clone" && r.targetVoiceUuid
          ? (voiceById.get(r.targetVoiceUuid) ?? null)
          : null,
      replaces: ownActive(r.characterId),
    });
  }
  for (const id of [...lines.keys()].sort()) {
    if (seen.has(id)) continue;
    const voice = voiceFor(book, id, issueId);
    if (voice) {
      const row = voice.voiceUuid ? voiceById.get(voice.voiceUuid) : null;
      if (row?.status !== "archived") continue;
      items.push({
        ...base(id),
        source: "archived voice",
        action: "restore",
        state: stateOf(tasks.get(id)),
        operation: decodeOp(tasks.get(id)),
        target: row,
        replaces: null,
      });
      continue;
    }
    if (skippedIn(book, id, issueId)) continue;
    const first = candidatesOf.get(id)?.[0];
    items.push({
      ...base(id),
      source: "no voice",
      action: first ? "clone" : "design",
      state: stateOf(tasks.get(id)),
      operation: decodeOp(tasks.get(id)),
      target: first ? (voiceById.get(first.id) ?? null) : null,
      replaces: null,
    });
  }

  const descriptions = await readDescriptions(
    sb,
    items.filter((i) => i.action === "design").map((i) => i.characterId),
  );
  for (const item of items) {
    // A run that has only claimed the item revalidates it with this plan.
    if (item.state !== "pending" && item.operation?.phase !== "claimed")
      continue;
    const id = item.characterId;
    if (book.resolve(id)?.id !== id)
      item.refusals.push(`no characters row for ${id}`);
    if (item.action === "design") {
      item.hasDescription = descriptions.has(voiceDesignAppearanceId(id));
      if (item.lines === 0) item.refusals.push("no lines in this issue");
      if (!item.hasDescription)
        item.warnings.push(
          "no stored description: carryOut makes one first (one GEMINI_MEDIUM call)",
        );
    } else if (!item.target) {
      item.refusals.push(`${item.action} target not found`);
    } else if (item.target.status === "active") {
      item.refusals.push(
        `${item.target.display_name} is already active: pick it as an active voice, no slot needed`,
      );
    } else {
      const check = await restoreVoice(deps, item.target);
      item.refusals.push(
        ...check.refusals.map((r) => `${item.target!.display_name}: ${r}`),
      );
    }
    item.needsSlot = item.state === "pending" && item.refusals.length === 0;
  }

  // The whole list planned together: items that replace a voice give that
  // voice back; the rest take a free slot, then the policy's picks. Every
  // outgoing voice is reserved for one item only.
  const slotItems = items.filter((i) => i.needsSlot);
  const replacing = slotItems.filter((i) => i.replaces);
  const others = slotItems.filter((i) => !i.replaces);
  const free = await planFreeSlots(deps, others.length, { bookId, issueId });
  let freeLeft = free.freeNow;
  const reserved = new Set<string>();
  const pool = [
    ...free.pick.map((voice) => ({ voice, checked: true })),
    ...free.spare.map((voice) => ({ voice, checked: false })),
  ];
  let poolAt = 0;
  /** The next policy voice no other item holds; spares get their bucket check here. */
  const nextPick = async (): Promise<VoiceRow | null> => {
    while (poolAt < pool.length) {
      const { voice, checked } = pool[poolAt++]!;
      if (reserved.has(voice.id)) continue;
      if (!checked && (await archiveRefusals(deps, voice, { needs })).length)
        continue;
      reserved.add(voice.id);
      return voice;
    }
    return null;
  };
  const leaves = (voice: VoiceRow, item: VoiceWorkItem) =>
    castlist
      .filter(
        (c) =>
          c.voice_uuid === voice.id &&
          !(
            item.replaces?.id === voice.id &&
            c.book_id === bookId &&
            rowCharacter(book, c) === item.characterId
          ),
      )
      .map((c) => ({
        bookId: c.book_id,
        issueId: c.issue_id,
        character: c.character,
      }));
  const archiveFirst = (voice: VoiceRow, item: VoiceWorkItem): Outgoing => ({
    kind: "archive",
    voice,
    order: "archive first",
    refusals: [],
    leavesWithoutVoice: leaves(voice, item),
  });

  // Replacements claim their own voice first; a second item replacing the
  // same voice gets a policy pick instead.
  const collided: VoiceWorkItem[] = [];
  for (const item of replacing) {
    if (reserved.has(item.replaces!.id)) collided.push(item);
    else reserved.add(item.replaces!.id);
  }
  for (const item of others) {
    if (freeLeft > 0) {
      item.outgoing = { kind: "free slot" };
      freeLeft--;
      continue;
    }
    const voice = await nextPick();
    item.outgoing = voice ? archiveFirst(voice, item) : null;
  }
  for (const item of replacing) {
    const old = item.replaces!;
    if (collided.includes(item)) {
      const voice = await nextPick();
      item.outgoing = voice ? archiveFirst(voice, item) : null;
      item.warnings.push(
        `${old.display_name} is already the outgoing voice of another item; ${voice ? `${voice.display_name} goes instead` : "no other voice can be archived"}`,
      );
      if (!voice) others.push(item);
      continue;
    }
    const without = new Set(needs);
    without.delete(old.id);
    const refusals = await archiveRefusals(deps, old, { needs: without });
    const order = freeLeft > 0 ? "add first" : "archive first";
    item.outgoing = {
      kind: "archive",
      voice: old,
      order,
      refusals,
      leavesWithoutVoice: leaves(old, item),
    };
    if (refusals.length > 0 && order === "add first")
      item.warnings.push(
        `${old.display_name} cannot be archived (${refusals.join(", ")}): it stays active after the add, or pick another voice to archive`,
      );
  }

  const refusals: string[] = [];
  const unplaced = others.filter((i) => !i.outgoing).length;
  if (unplaced > 0)
    refusals.push(
      `${unplaced} item(s) have no slot: ${free.freeNow} free and only ${free.pick.length} voice(s) the policy can archive`,
    );
  const blocked = slotItems.filter(
    (i) =>
      i.outgoing?.kind === "archive" &&
      i.outgoing.order === "archive first" &&
      i.outgoing.refusals.length > 0,
  ).length;
  if (blocked > 0)
    refusals.push(
      `${blocked} replacement(s) need their old voice archived first and it is refused; pick another voice for each`,
    );
  if (free.addEditHeadroom < slotItems.length)
    refusals.push(
      `add/edit headroom ${free.addEditHeadroom} is below the ${slotItems.length} add(s) planned`,
    );

  return {
    bookId,
    issueId,
    status: free.status,
    freeNow: free.freeNow,
    addEditHeadroom: free.addEditHeadroom,
    adds: slotItems.length,
    archives: slotItems.filter((i) => i.outgoing?.kind === "archive").length,
    items,
    ok:
      refusals.length === 0 &&
      items.every((i) => i.state !== "pending" || i.refusals.length === 0),
    refusals,
    spare: free.spare,
    refusedVoices: free.refused,
    unsettled: items.filter((i) => i.state !== "settled").length,
  };
}

export type CarryOutResult =
  | { status: "refused"; reasons: string[] }
  /** The add was refused; nothing new exists. `restored` when the archived voice came back. */
  | { status: "failed"; reasons: string[]; restored?: string }
  /**
   * Stopped with something uncertain. The operation stays recorded on the
   * item's `casting_tasks` row, which refuses another create until
   * `reconcile` settles it.
   */
  | {
      status: "needs attention";
      reasons: string[];
      /** The voice archived for this item, which the Restore button brings back. */
      archived?: { id: string; name: string };
      newElevenLabsId?: string;
    }
  | {
      status: "done";
      voiceUuid: string;
      elevenLabsId: string;
      castlistRows: number;
      archived: { id: string; name: string } | null;
      warnings: string[];
    };

type Added =
  | { kind: "added"; elevenLabsId: string; recorded: boolean }
  | { kind: "refused"; reason: string }
  | { kind: "uncertain"; reason: string };

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

function classify(err: unknown): Added {
  if (
    err instanceof ElevenLabsRefusedError ||
    err instanceof ElevenLabsHeadroomError
  )
    return { kind: "refused", reason: message(err) };
  return { kind: "uncertain", reason: message(err) };
}

type ItemKey = Pick<
  VoiceWorkItem,
  "bookId" | "issueId" | "characterId" | "action" | "target"
>;

const taskRow = (client: SupabaseClient, item: ItemKey) =>
  client
    .from("casting_tasks")
    .select("status")
    .eq("book_id", item.bookId)
    .eq("issue_id", item.issueId)
    .eq("character_id", item.characterId);

/** Moves the task row from `from` to `to`; false when the row is not at `from`. */
async function moveTask(
  client: SupabaseClient,
  item: ItemKey,
  from: string,
  to: string,
  completed = false,
): Promise<boolean> {
  const upd = await client
    .from("casting_tasks")
    .update({
      status: to,
      completed_at: completed ? new Date().toISOString() : null,
    })
    .eq("book_id", item.bookId)
    .eq("issue_id", item.issueId)
    .eq("character_id", item.characterId)
    .eq("status", from)
    .select("id");
  fail(`moving ${item.characterId}'s casting task to ${to}`, upd.error);
  return (upd.data ?? []).length > 0;
}

/** Upserts the item's `casting_tasks` row to `status`; inserts one for a speaker with no request. */
async function markTask(
  client: SupabaseClient,
  item: ItemKey,
  status: "in_progress" | "complete",
): Promise<void> {
  const completed_at = status === "complete" ? new Date().toISOString() : null;
  const upd = await client
    .from("casting_tasks")
    .update({ status, completed_at })
    .eq("book_id", item.bookId)
    .eq("issue_id", item.issueId)
    .eq("character_id", item.characterId)
    .select("id");
  fail(`marking ${item.characterId}'s casting task ${status}`, upd.error);
  if ((upd.data ?? []).length > 0) return;
  const ins = await client.from("casting_tasks").insert({
    book_id: item.bookId,
    issue_id: item.issueId,
    character_id: item.characterId,
    action: item.action === "design" ? "design" : "clone",
    target_voice_uuid: item.target?.id ?? null,
    status,
    completed_at,
  });
  fail(`inserting ${item.characterId}'s casting task`, ins.error);
}

/**
 * Claims the item for one run, atomically, before anything is spent: the
 * task row moves from `pending` to the op record, or a row is inserted with
 * it (the unique key refuses a second insert). Returns whether a row was
 * inserted, so a release can remove it again.
 */
async function claimTask(
  client: SupabaseClient,
  item: ItemKey,
  op: OpRecord,
): Promise<{ ok: true; inserted: boolean } | { ok: false; reason: string }> {
  const status = encodeOp(op);
  if (await moveTask(client, item, "pending", status))
    return { ok: true, inserted: false };
  const { data, error } = await taskRow(client, item);
  fail(`reading ${item.characterId}'s casting task`, error);
  const held = (data ?? []) as { status: string }[];
  if (held.length > 0)
    return {
      ok: false,
      reason: `the item is ${stateOf(held[0]!.status)}${decodeOp(held[0]!.status) ? ` (operation at ${decodeOp(held[0]!.status)!.phase})` : ""}`,
    };
  const ins = await client.from("casting_tasks").insert({
    book_id: item.bookId,
    issue_id: item.issueId,
    character_id: item.characterId,
    action: item.action === "design" ? "design" : "clone",
    target_voice_uuid: item.target?.id ?? null,
    status,
  });
  if (ins.error)
    return {
      ok: false,
      reason: `another run claimed the item first (${ins.error.message})`,
    };
  return { ok: true, inserted: true };
}

/** Points the character's castlist rows in every issue of the book at the voice; adds this issue's row first when it has none. */
async function castVoice(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
  characterId: string,
  voiceUuid: string,
): Promise<number> {
  const book = await loadBookCast(client, bookId);
  if (
    !book.rows.some(
      (r) => r.issue_id === issueId && rowCharacter(book, r) === characterId,
    )
  )
    await addToCast(client, bookId, issueId, characterId);
  return setVoice(client, bookId, characterId, voiceUuid);
}

/**
 * Records a voice that exists on ElevenLabs: its `voices` row (found by the
 * ElevenLabs id first, so a rerun never inserts a second), the replaced
 * voice's metadata, the castlist in every issue, and the task `in_progress`.
 * Every write is safe to repeat.
 */
async function recordVoice(
  deps: VoiceSlotsDeps,
  item: VoiceWorkItem,
  elevenLabsId: string,
  description: string | null,
  restored: boolean,
): Promise<{ voiceUuid: string; castlistRows: number }> {
  const sb = deps.supabase;
  const { characterId } = item;
  let voiceUuid: string;
  if (item.action === "design") {
    const found = await sb
      .from("voices")
      .select("id")
      .eq("current_elevenlabs_id", elevenLabsId)
      .limit(1);
    fail(`looking up ${elevenLabsId}`, found.error);
    voiceUuid =
      ((found.data ?? []) as { id: string }[])[0]?.id ??
      (await registerVoice(sb, {
        display_name: item.name,
        current_elevenlabs_id: elevenLabsId,
        description,
        labels: null,
        source_clip_path: null,
        source_clip_md5: null,
        character_id: characterId,
        design_prompt: description,
      }));
  } else {
    voiceUuid = item.target!.id;
    if (!restored) {
      const row = await readVoice(sb, voiceUuid);
      if (row?.current_elevenlabs_id !== elevenLabsId)
        await markRestored(sb, row ?? item.target!, elevenLabsId);
    }
    const own = await sb
      .from("voices")
      .update({ character_id: characterId })
      .eq("id", voiceUuid)
      .is("character_id", null);
    fail(`filing ${voiceUuid} under ${characterId}`, own.error);
  }
  if (item.replaces) {
    // #114 decision 2: the new voice carries the replaced one's metadata.
    const copy = await sb
      .from("voices")
      .update({
        description: item.replaces.description,
        labels: item.replaces.labels,
      })
      .eq("id", voiceUuid);
    fail(`copying ${item.replaces.display_name}'s metadata`, copy.error);
  }
  const castlistRows = await castVoice(
    sb,
    item.bookId,
    item.issueId,
    characterId,
    voiceUuid,
  );
  await markTask(sb, item, "in_progress");
  return { voiceUuid, castlistRows };
}

/**
 * Performs one item of the issue's voice work. `archiveVoiceId` is the only
 * voice it may archive (null: use a free slot).
 *
 * First it claims the item on its `casting_tasks` row, atomically, before
 * any paid call (Gemini included), then re-plans and refuses when the item
 * changed or is refused. Each step is recorded on that row before and after
 * it spends (`archiving`, `archived`, `adding`, `added`), with the inventory
 * and the per-add token, so a crash or an uncertain reply leaves the item
 * "needs attention" and no second create runs until `reconcile` settles it.
 * It holds the operation claim on every `voices` row it changes and never
 * retries a request. A refused add after an archive restores the archived
 * voice; a lost reply is matched only by the add's token, name and the
 * inventory taken before it.
 */
export async function carryOut(
  deps: VoiceSlotsDeps,
  item: ItemKey,
  opts: { archiveVoiceId: string | null },
): Promise<CarryOutResult> {
  const sb = deps.supabase;
  const op: OpRecord = { token: randomUUID(), phase: "claimed" };
  const claim = await claimTask(sb, item, op);
  if (!claim.ok) return { status: "refused", reasons: [claim.reason] };

  let status = encodeOp(op);
  /** Records the next phase; the row must still hold the previous one. */
  const record = async (next: Partial<OpRecord>) => {
    Object.assign(op, next);
    const to = encodeOp(op);
    if (!(await moveTask(sb, item, status, to)))
      throw new Error("the item's operation record changed under this run");
    status = to;
  };

  try {
    const result = await carryOutClaimed(deps, item, opts, op, record);
    // Refused or failed: nothing of the operation remains, give the item back.
    if (result.status === "refused" || result.status === "failed")
      await releaseTaskAt(sb, item, status, claim.inserted);
    return result;
  } catch (err) {
    if (op.phase === "claimed") {
      await releaseTaskAt(sb, item, status, claim.inserted).catch(
        () => undefined,
      );
      throw err;
    }
    return {
      status: "needs attention",
      reasons: [
        `stopped after ${op.phase}: ${message(err)}`,
        "the operation is recorded on the item; run reconcile",
      ],
    };
  }
}

/** Gives the item back when nothing of the operation remains. */
async function releaseTaskAt(
  client: SupabaseClient,
  item: ItemKey,
  status: string,
  inserted: boolean,
): Promise<void> {
  if (!inserted) {
    await moveTask(client, item, status, "pending");
    return;
  }
  const del = await client
    .from("casting_tasks")
    .delete()
    .eq("book_id", item.bookId)
    .eq("issue_id", item.issueId)
    .eq("character_id", item.characterId)
    .eq("status", status);
  fail(`releasing ${item.characterId}'s casting task`, del.error);
}

async function carryOutClaimed(
  deps: VoiceSlotsDeps,
  item: ItemKey,
  opts: { archiveVoiceId: string | null },
  op: OpRecord,
  record: (next: Partial<OpRecord>) => Promise<void>,
): Promise<CarryOutResult> {
  const sb = deps.supabase;
  const refuse = (...reasons: string[]): CarryOutResult => ({
    status: "refused",
    reasons,
  });
  const { bookId, issueId, characterId } = item;

  // Revalidate under the claim: the plan shows this run's own record.
  const plan = await planVoiceWork(deps, bookId, issueId);
  const fresh = plan.items.find((i) => i.characterId === characterId);
  if (!fresh) return refuse(`${characterId} is no longer voice work here`);
  if (
    fresh.action !== item.action ||
    (fresh.target?.id ?? null) !== (item.target?.id ?? null)
  )
    return refuse("the item changed since its plan; plan again");
  if (fresh.operation?.token !== op.token)
    return refuse(`the item is ${fresh.state}`);
  if (fresh.refusals.length > 0) return refuse(...fresh.refusals);
  if (plan.addEditHeadroom < 1)
    return refuse(
      `no add/edit headroom (${plan.status.voice_add_edit_counter} of ${plan.status.max_voice_add_edits} used)`,
    );

  let archiveRow: VoiceRow | null = null;
  if (opts.archiveVoiceId) {
    archiveRow = await readVoice(sb, opts.archiveVoiceId);
    if (!archiveRow) return refuse(`no voice ${opts.archiveVoiceId}`);
  }
  const addFirst = plan.freeNow > 0;
  if (!addFirst && !archiveRow)
    return refuse("no free slot, and no voice was named to archive");
  // The "needed by issue" refusal does not apply to the voice it replaces.
  const needs = await issueNeeds(sb, { bookId, issueId });
  if (archiveRow && fresh.replaces?.id === archiveRow.id)
    needs.delete(archiveRow.id);
  if (archiveRow) {
    const why = await archiveRefusals(deps, archiveRow, { needs });
    if (why.length > 0)
      return refuse(
        `${archiveRow.display_name} cannot be archived: ${why.join(", ")}`,
      );
  }

  let description: string | null = null;
  if (fresh.action === "design") {
    const read = async () =>
      (await readDescriptions(sb, [characterId])).get(
        voiceDesignAppearanceId(characterId),
      ) ?? null;
    description = await read();
    if (!description) {
      const { getGeminiClient } = await import("~/lib/gemini-client");
      const { generateContentLogged } = await import("~/lib/llm-usage");
      await describeVoices(
        sb as Parameters<typeof describeVoices>[0],
        getGeminiClient(),
        bookId,
        issueId,
        { only: [characterId], generate: generateContentLogged },
      );
      description = await read();
    }
    if (!description)
      return {
        status: "failed",
        reasons: [
          `no description could be made for ${characterId} (no voice description snippets on its bubbles)`,
        ],
      };
  }

  // The inventory before anything changes: a lost reply is matched against it.
  let before: string[];
  try {
    before = (await listVoices(deps)).map((v) => v.voice_id);
  } catch (err) {
    return refuse(`could not list the account's voices: ${message(err)}`);
  }
  const name = fresh.target?.display_name ?? fresh.name;
  const archived = archiveRow
    ? { id: archiveRow.id, name: archiveRow.display_name }
    : undefined;

  const run = async (): Promise<CarryOutResult> => {
    const warnings: string[] = [];
    let didArchive = false;
    let deleteConfirmed = false;
    const archive = async () => {
      try {
        const r = await archiveVoice(deps, archiveRow!, {
          needs,
          execute: true,
        });
        return r.executed
          ? { ok: true as const }
          : { ok: false as const, why: r.refusals.join(", ") };
      } catch (err) {
        if (err instanceof ArchiveRecordError) {
          deleteConfirmed = true;
          warnings.push(err.message);
          return { ok: true as const };
        }
        throw err;
      }
    };

    if (!addFirst && archiveRow) {
      await record({ phase: "archiving", archived: archiveRow.id });
      let r;
      try {
        r = await archive();
      } catch (err) {
        return {
          status: "needs attention",
          reasons: [
            `archiving ${archiveRow.display_name} did not finish: ${message(err)}`,
            "it may have landed; nothing was retried and nothing more was changed",
          ],
          archived,
        };
      }
      if (!r.ok)
        return refuse(
          `${archiveRow.display_name} cannot be archived: ${r.why}`,
        );
      didArchive = true;
      await record({ phase: "archived" });
    }

    await record({ phase: "adding", before, name });
    let added: Added;
    if (fresh.action === "design") {
      try {
        const r = await designVoice(deps, {
          name,
          description: description!,
          opToken: op.token,
          meta: { step: "voices-stop", bookId, issueId },
        });
        added = { kind: "added", elevenLabsId: r.voice_id, recorded: false };
      } catch (err) {
        added = classify(err);
      }
    } else {
      try {
        const r = await restoreVoice(deps, fresh.target!, {
          execute: true,
          opToken: op.token,
        });
        added =
          r.executed && r.newElevenLabsId
            ? { kind: "added", elevenLabsId: r.newElevenLabsId, recorded: true }
            : { kind: "refused", reason: r.refusals.join(", ") };
      } catch (err) {
        added = classify(err);
      }
    }

    if (added.kind === "refused") {
      if (!didArchive) return { status: "failed", reasons: [added.reason] };
      const back = await restoreArchived(deps, archiveRow!, deleteConfirmed);
      return back.ok
        ? {
            status: "failed",
            reasons: [added.reason],
            restored: archiveRow!.display_name,
          }
        : {
            status: "needs attention",
            reasons: [added.reason, back.why],
            archived,
          };
    }
    if (added.kind === "uncertain") {
      const found = await matchLostAdd(deps, op);
      if (!found.ok)
        return {
          status: "needs attention",
          reasons: [
            `the add's reply was lost: ${added.reason}`,
            found.why,
            "nothing was retried and nothing more was changed",
          ],
          archived: didArchive ? archived : undefined,
        };
      warnings.push(
        `the add's reply was lost (${added.reason}); found the new voice ${found.id} by its token`,
      );
      added = { kind: "added", elevenLabsId: found.id, recorded: false };
    }

    const elevenLabsId = added.elevenLabsId;
    await record({ phase: "added", elevenLabsId });
    let saved: { voiceUuid: string; castlistRows: number };
    try {
      saved = await recordVoice(
        deps,
        fresh,
        elevenLabsId,
        description,
        added.recorded,
      );
    } catch (err) {
      return {
        status: "needs attention",
        reasons: [
          `the voice ${elevenLabsId} exists on ElevenLabs, but recording it failed: ${message(err)}`,
          "the item refuses another create; reconcile finishes the rows",
        ],
        archived: didArchive ? archived : undefined,
        newElevenLabsId: elevenLabsId,
      };
    }

    if (addFirst && archiveRow) {
      try {
        const r = await archive();
        if (r.ok) didArchive = true;
        else
          warnings.push(
            `${archiveRow.display_name} was not archived: ${r.why}`,
          );
      } catch (err) {
        warnings.push(
          `archiving ${archiveRow.display_name} did not finish (${message(err)}); it may have landed, check ElevenLabs before archiving it again`,
        );
      }
    }
    return {
      status: "done",
      voiceUuid: saved.voiceUuid,
      elevenLabsId,
      castlistRows: saved.castlistRows,
      archived: didArchive ? (archived ?? null) : null,
      warnings,
    };
  };

  // Claims on the `voices` rows it changes: the voice archived, and the
  // voice that comes back (or, for a design, the voice it replaces). The
  // task-row claim above covers a design that changes no existing row.
  const held =
    fresh.target ?? (fresh.action === "design" ? fresh.replaces : null);
  const holdTarget = () =>
    held && held.id !== archiveRow?.id
      ? withVoiceOperationClaim(sb, held, fresh.action, run)
      : run();
  return archiveRow
    ? withVoiceOperationClaim(sb, archiveRow, "archive", holdTarget)
    : holdTarget();
}

/** Brings an archived voice back after a refused add. */
async function restoreArchived(
  deps: VoiceSlotsDeps,
  voice: VoiceRow,
  deleteConfirmed: boolean,
): Promise<{ ok: true } | { ok: false; why: string }> {
  try {
    const back = await readVoice(deps.supabase, voice.id);
    if (!back)
      return { ok: false, why: `${voice.display_name}: row not found` };
    const r = await restoreVoice(deps, back, {
      execute: true,
      deleteConfirmed,
    });
    return r.executed
      ? { ok: true }
      : {
          ok: false,
          why: `restoring ${voice.display_name} was refused: ${r.refusals.join(", ")}`,
        };
  } catch (err) {
    return {
      ok: false,
      why: `restoring ${voice.display_name} did not finish: ${message(err)}`,
    };
  }
}

/** The one voice a lost add made, by its token, name and the inventory before it. */
async function matchLostAdd(
  deps: VoiceSlotsDeps,
  op: OpRecord,
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
    return { ok: false, why: `the lookup failed: ${message(err)}` };
  }
}

/**
 * Settles an item that `carryOut` left "needs attention", from the record on
 * its task row; it makes no new voice. `added`: finishes the rows. `adding`:
 * adopts the voice carrying the add's token, or, with `notAdded` (the owner
 * checked ElevenLabs), restores what was archived and gives the item back.
 * `claimed` and `archived`: restores what was archived and gives it back.
 * `archiving`: can't tell whether the DELETE landed, so it stops.
 */
export async function reconcile(
  deps: VoiceSlotsDeps,
  item: ItemKey,
  opts: { notAdded?: boolean } = {},
): Promise<CarryOutResult> {
  const sb = deps.supabase;
  const { data, error } = await taskRow(sb, item);
  fail(`reading ${item.characterId}'s casting task`, error);
  const status = ((data ?? []) as { status: string }[])[0]?.status ?? "";
  const op = decodeOp(status);
  if (!op)
    return {
      status: "refused",
      reasons: [`nothing to reconcile: the item is ${stateOf(status)}`],
    };
  const plan = await planVoiceWork(deps, item.bookId, item.issueId);
  const fresh = plan.items.find((i) => i.characterId === item.characterId);
  if (!fresh) return { status: "refused", reasons: ["the item is gone"] };
  const archivedRow = op.archived ? await readVoice(sb, op.archived) : null;
  const archived = archivedRow
    ? { id: archivedRow.id, name: archivedRow.display_name }
    : undefined;
  const giveBack = async (): Promise<CarryOutResult> => {
    if (archivedRow) {
      const back = await restoreArchived(deps, archivedRow, false);
      if (!back.ok)
        return { status: "needs attention", reasons: [back.why], archived };
    }
    if (!(await moveTask(sb, item, status, "pending")))
      return {
        status: "needs attention",
        reasons: ["the item's record changed during reconcile"],
      };
    return {
      status: "failed",
      reasons: ["no voice was made; the item is pending again"],
      restored: archived?.name,
    };
  };

  let elevenLabsId = op.elevenLabsId;
  if (op.phase === "archiving")
    return {
      status: "needs attention",
      reasons: [
        "the archive's DELETE may or may not have landed; check ElevenLabs, then Restore the voice from /admin/voices if it is gone",
      ],
      archived,
    };
  if (op.phase === "claimed" || op.phase === "archived") return giveBack();
  if (op.phase === "adding") {
    const found = await matchLostAdd(deps, op);
    if (!found.ok) {
      if (opts.notAdded) return giveBack();
      return { status: "needs attention", reasons: [found.why], archived };
    }
    elevenLabsId = found.id;
    Object.assign(op, { phase: "added", elevenLabsId });
    if (!(await moveTask(sb, item, status, encodeOp(op))))
      return {
        status: "needs attention",
        reasons: ["the item's record changed during reconcile"],
      };
  }
  const description =
    fresh.action === "design"
      ? ((await readDescriptions(sb, [item.characterId])).get(
          voiceDesignAppearanceId(item.characterId),
        ) ?? null)
      : null;
  try {
    const saved = await recordVoice(
      deps,
      fresh,
      elevenLabsId!,
      description,
      false,
    );
    return {
      status: "done",
      voiceUuid: saved.voiceUuid,
      elevenLabsId: elevenLabsId!,
      castlistRows: saved.castlistRows,
      archived: archived ?? null,
      warnings: ["reconciled from the recorded operation"],
    };
  } catch (err) {
    return {
      status: "needs attention",
      reasons: [`recording ${elevenLabsId} failed again: ${message(err)}`],
      archived,
      newElevenLabsId: elevenLabsId,
    };
  }
}

export type SettleOutcome =
  /** He accepts the voice `carryOut` made. */
  | { kind: "accept" }
  /** He picks an active voice instead; no slot. */
  | { kind: "pick"; voiceUuid: string }
  /** No audio for this character this run. */
  | { kind: "no audio" };

/**
 * Writes the skip sentinel on the character's castlist rows in this issue
 * (adding the row through `cast.ts` when there is none), with `voice_uuid`
 * cleared, so the audio step skips its bubbles. Rows match as `cast.ts`
 * matches them; `cast.ts` has no skip writer, so the update is here.
 */
async function skipInIssue(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
  characterId: string,
): Promise<void> {
  const here = (book: BookCast) =>
    book.rows.filter(
      (r) => r.issue_id === issueId && rowCharacter(book, r) === characterId,
    );
  let rows = here(await loadBookCast(client, bookId));
  if (rows.length === 0) {
    await addToCast(client, bookId, issueId, characterId);
    rows = here(await loadBookCast(client, bookId));
  }
  for (const row of rows) {
    const upd = await client
      .from("castlist")
      .update({
        character_id: characterId,
        voice_id: SKIPPED_VOICE,
        voice_uuid: null,
      })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("character", row.character);
    fail(`skipping ${characterId} in ${issueId}`, upd.error);
  }
}

/** Settles one item: points the cast at a picked voice or skips the character, then marks its `casting_tasks` row complete. */
export async function settle(
  client: SupabaseClient,
  item: ItemKey,
  outcome: SettleOutcome,
): Promise<void> {
  const { data, error } = await taskRow(client, item);
  fail(`reading ${item.characterId}'s casting task`, error);
  const status = ((data ?? []) as { status: string }[])[0]?.status;
  if (status && decodeOp(status))
    throw new Error(
      `voice work: ${item.characterId} has an operation to reconcile first`,
    );
  if (outcome.kind === "accept" && status !== "in_progress")
    throw new Error(
      `voice work: ${item.characterId} has no voice made to accept`,
    );
  if (outcome.kind === "pick") {
    const voice = await readVoice(client, outcome.voiceUuid);
    if (voice?.status !== "active")
      throw new Error(
        `voice work: ${outcome.voiceUuid} is not an active voice`,
      );
    await castVoice(
      client,
      item.bookId,
      item.issueId,
      item.characterId,
      voice.id,
    );
  }
  if (outcome.kind === "no audio")
    await skipInIssue(client, item.bookId, item.issueId, item.characterId);
  await markTask(client, item, "complete");
}
