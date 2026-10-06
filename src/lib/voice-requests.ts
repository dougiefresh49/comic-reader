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
  castVoiceInBook,
  loadBookCast,
  readVoiceRequests,
  setNoAudio,
  voiceFor,
} from "~/lib/cast";
import {
  ArchiveRecordError,
  ElevenLabsHeadroomError,
  ElevenLabsRefusedError,
  activateDesignedVoice,
  archiveRefusals,
  archiveVoice,
  designVoice,
  CLAIM_STALE_MS,
  claimHeld,
  designDescriptions,
  findOpVoices,
  finishArchive,
  issueNeeds,
  listVoices,
  markRestored,
  planFreeSlots,
  readCastlist,
  readCharacterVoices,
  readStoredDesign,
  readVoice,
  readVoices,
  restoreVoice,
  withVoiceOperationClaim,
  type SlotStatus,
  type VoiceClaimOperation,
  type VoiceRow,
  type VoiceSlotsDeps,
} from "~/lib/voice-slots";
import {
  ownRowStop,
  readSpeakerLines,
  silencedIn,
} from "~/workflows/steps/casting-tasks";
import { describeVoices } from "~/workflows/steps/voice";

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
  /** voice-lab clones filed under the character (archived), `starting_pick` first. */
  candidates: { id: string; name: string; labDefault: boolean }[];
  /** The character's non-ignored, non-silent bubbles in the issue. */
  lines: number;
  /** Design: a description is stored on the character's `needs_clip` voice with no appearance. */
  hasDescription: boolean;
  /**
   * The character's active designed voices (appearance null) when this item
   * was planned. A design refuses only a designed voice not in this list: a
   * competing run made it after the plan (#458).
   */
  designedVoices: string[];
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

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`voice work: ${what}: ${error.message}`);
}

async function readTasks(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<Map<string, TaskRow>> {
  const { data, error } = await client
    .from("casting_tasks")
    .select("character_id, status, operation")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);
  fail("reading casting tasks", error);
  return new Map(
    ((data ?? []) as (TaskRow & { character_id: string })[]).map((t) => [
      t.character_id,
      t,
    ]),
  );
}

/** Each character's stored design description (#458), by character id. */
async function readDescriptions(
  client: SupabaseClient,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  return designDescriptions(await readCharacterVoices(client, ids));
}

/**
 * A `carryOut` in flight, kept in `casting_tasks.operation` (decisions rows
 * 263 and 264) while `status` keeps its plain value: the claim's token, a
 * `rev` that changes on every write (each write is a compare-and-swap on
 * it), the last phase reached, and what `reconcile` needs. Phases: `claimed` (nothing spent on ElevenLabs),
 * `archiving` (DELETE sent), `archived` (DELETE confirmed), `adding` (add
 * sent, `before` and `name` recorded), `added` (ElevenLabs id known),
 * `retiring` (the item's voice is recorded; the outgoing voice's DELETE is
 * sent) and `retired` (that DELETE confirmed, its registry write failed).
 * `back` marks an add that restores the archived voice instead of making
 * the item's voice.
 */
export interface OpRecord {
  token: string;
  rev: string;
  /** When the record was last written; a younger one is a live run. */
  at?: string;
  phase:
    | "claimed"
    | "archiving"
    | "archived"
    | "adding"
    | "added"
    | "retiring"
    | "retired";
  back?: boolean;
  /** `voices.id` archived for the item. */
  archived?: string;
  /** `voices.id` of the voice the item replaces, for the metadata copy. */
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
 * The task row fields this module reads. `database.ts` types `operation` as `Json`; this narrows it to `OpRecord`.
 */
interface TaskRow {
  status: string;
  operation: OpRecord | null;
}

function stateOf(task: TaskRow | undefined): VoiceWorkState {
  if (task?.operation) return "needs attention";
  const status = task?.status;
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
  // Lines per character: the voices gate's own rule (#406).
  const lines = new Map(
    [...(await readSpeakerLines(sb, bookId, issueId))].map(
      ([id, list]) => [id, list.length] as const,
    ),
  );
  const voiceById = new Map(voices.map((v) => [v.id, v]));
  const candidatesOf = new Map<string, VoiceWorkItem["candidates"]>();
  for (const v of voices) {
    if (v.status !== "archived" || !v.character_id) continue;
    const list = candidatesOf.get(v.character_id) ?? [];
    list.push({ id: v.id, name: v.display_name, labDefault: v.starting_pick });
    candidatesOf.set(v.character_id, list);
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
    designedVoices: voices
      .filter(
        (v) =>
          v.character_id === id &&
          v.status === "active" &&
          v.appearance_id === null,
      )
      .map((v) => v.id),
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
      state: stateOf(tasks.get(r.characterId)),
      operation: tasks.get(r.characterId)?.operation ?? null,
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
        operation: tasks.get(id)?.operation ?? null,
        target: row,
        replaces: null,
      });
      continue;
    }
    if (silencedIn(book, id, issueId)) continue;
    const first = candidatesOf.get(id)?.[0];
    items.push({
      ...base(id),
      source: "no voice",
      action: first ? "clone" : "design",
      state: stateOf(tasks.get(id)),
      operation: tasks.get(id)?.operation ?? null,
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
    // A request for a character its own row removes or silences here takes
    // no slot and is never run: the render chain would not play its voice.
    const stop = ownRowStop(book, id, issueId);
    if (stop) item.refusals.push(stop);
    if (item.action === "design") {
      item.hasDescription = descriptions.has(id);
      if (item.lines === 0) item.refusals.push("no lines in this issue");
      if (!item.hasDescription)
        item.warnings.push(
          "no stored description: carryOut makes one first (one GEMINI_MEDIUM call)",
        );
    } else if (!item.target) {
      item.refusals.push(`${item.action} target not found`);
    } else if (item.target.status === "needs_clip") {
      // Never run, takes no slot (#458): voice-lab has not delivered the clip.
      item.refusals.push(
        `${item.target.display_name} is waiting for a clip from voice-lab`,
      );
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
            c.character_id === item.characterId
          ),
      )
      .map((c) => ({
        bookId: c.book_id,
        issueId: c.issue_id,
        character: c.display_name,
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
      // As for the items that replace nothing: a free slot first, then a pick.
      if (freeLeft > 0) {
        item.outgoing = { kind: "free slot" };
        freeLeft--;
        item.warnings.push(
          `${old.display_name} is already the outgoing voice of another item; this item takes the free slot`,
        );
        continue;
      }
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

/** A 4xx or a pre-send refusal added nothing; a 5xx, a timeout or an unread reply may have. */
function classify(err: unknown): Added {
  if (
    (err instanceof ElevenLabsRefusedError && (err.status ?? 0) < 500) ||
    err instanceof ElevenLabsHeadroomError
  )
    return { kind: "refused", reason: message(err) };
  return { kind: "uncertain", reason: message(err) };
}

type ItemKey = Pick<
  VoiceWorkItem,
  "bookId" | "issueId" | "characterId" | "action" | "target"
>;

/**
 * What `carryOut` takes: the key, plus `designedVoices` from the plan the
 * owner saw (the page load, not a re-plan at click time), which the design
 * guard measures a competing run's voice against (#458).
 */
export type RunKey = ItemKey & Pick<VoiceWorkItem, "designedVoices">;

const taskRow = (client: SupabaseClient, item: ItemKey) =>
  client
    .from("casting_tasks")
    .select("status, operation, target_voice_uuid")
    .eq("book_id", item.bookId)
    .eq("issue_id", item.issueId)
    .eq("character_id", item.characterId);

/**
 * Writes the item's op record (`null` clears it) as a compare-and-swap: only
 * while the row holds the record with `from.rev` (`null`: no record), and
 * `from.status` when given. `status` also sets the row's status. False when
 * the row did not match.
 */
async function swapOperation(
  client: SupabaseClient,
  item: ItemKey,
  from: { rev: string | null; status?: string },
  next: OpRecord | null,
  status?: string,
): Promise<boolean> {
  let q = client
    .from("casting_tasks")
    .update({
      operation: next,
      ...(status ? { status, completed_at: null } : {}),
    })
    .eq("book_id", item.bookId)
    .eq("issue_id", item.issueId)
    .eq("character_id", item.characterId);
  q =
    from.rev === null
      ? q.is("operation", null)
      : q.eq("operation->>rev", from.rev);
  if (from.status) q = q.eq("status", from.status);
  const upd = await q.select("id");
  fail(`writing ${item.characterId}'s operation record`, upd.error);
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
    .is("operation", null)
    .select("id");
  fail(`marking ${item.characterId}'s casting task ${status}`, upd.error);
  if ((upd.data ?? []).length > 0) return;
  const row = await taskRow(client, item);
  fail(`reading ${item.characterId}'s casting task`, row.error);
  if ((row.data ?? []).length > 0)
    throw new Error(
      `voice work: ${item.characterId} has an open operation; reconcile it first`,
    );
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
 * Claims the item for one run, atomically, before anything is spent: a
 * `pending` row with no record takes the op record, or a row is inserted
 * with it (the unique key refuses a second insert). Returns whether a row
 * was inserted, so a release can remove it again.
 */
async function claimTask(
  client: SupabaseClient,
  item: ItemKey,
  op: OpRecord,
): Promise<{ ok: true; inserted: boolean } | { ok: false; reason: string }> {
  if (await swapOperation(client, item, { rev: null, status: "pending" }, op))
    return { ok: true, inserted: false };
  const { data, error } = await taskRow(client, item);
  fail(`reading ${item.characterId}'s casting task`, error);
  const held = ((data ?? []) as TaskRow[])[0];
  if (held)
    return {
      ok: false,
      reason: `the item is ${stateOf(held)}${held.operation ? ` (operation at ${held.operation.phase})` : ""}`,
    };
  const ins = await client.from("casting_tasks").insert({
    book_id: item.bookId,
    issue_id: item.issueId,
    character_id: item.characterId,
    action: item.action === "design" ? "design" : "clone",
    target_voice_uuid: item.target?.id ?? null,
    status: "pending",
    operation: op,
  });
  if (ins.error)
    return {
      ok: false,
      reason: `another run claimed the item first (${ins.error.message})`,
    };
  return { ok: true, inserted: true };
}

/**
 * Records a voice that exists on ElevenLabs: its `voices` row (found by the
 * ElevenLabs id first, so a rerun never inserts a second), the replaced
 * voice's metadata, and the castlist in every issue. Every write is safe to
 * repeat; the caller ends the item's record.
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
    // The character's stored design row becomes the voice; none, a new row.
    voiceUuid =
      ((found.data ?? []) as { id: string }[])[0]?.id ??
      (await activateDesignedVoice(sb, {
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
  const castlistRows = await castVoiceInBook(
    sb,
    item.bookId,
    item.issueId,
    characterId,
    voiceUuid,
  );
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
  item: RunKey,
  opts: { archiveVoiceId: string | null },
): Promise<CarryOutResult> {
  const sb = deps.supabase;
  const op: OpRecord = {
    token: randomUUID(),
    rev: randomUUID(),
    at: new Date().toISOString(),
    phase: "claimed",
  };
  const claim = await claimTask(sb, item, op);
  if (!claim.ok) return { status: "refused", reasons: [claim.reason] };
  const rec = recorder(sb, item, op);

  try {
    const result = await carryOutClaimed(deps, item, opts, rec);
    // Refused or failed: nothing of the operation remains, give the item back.
    if (result.status === "refused" || result.status === "failed")
      await releaseTaskAt(sb, item, op.rev, claim.inserted);
    return result;
  } catch (err) {
    if (op.phase === "claimed") {
      await releaseTaskAt(sb, item, op.rev, claim.inserted).catch(
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

/**
 * The item's operation record and its compare-and-swap writes: each write
 * needs the row to hold the last status this run wrote, so a second run
 * that took the row stops this one before it spends.
 */
interface Recorder {
  op: OpRecord;
  /** Records the next phase. */
  record: (next: Partial<OpRecord>) => Promise<void>;
  /** Ends the record (`operation = null`) and sets the row's status. */
  end: (to: "in_progress" | "pending") => Promise<boolean>;
}

function recorder(sb: SupabaseClient, item: ItemKey, op: OpRecord): Recorder {
  return {
    op,
    record: async (next) => {
      const to: OpRecord = {
        ...op,
        ...next,
        rev: randomUUID(),
        at: new Date().toISOString(),
      };
      if (!(await swapOperation(sb, item, { rev: op.rev }, to)))
        throw new Error("the item's operation record changed under this run");
      Object.assign(op, to);
    },
    end: (to) => swapOperation(sb, item, { rev: op.rev }, null, to),
  };
}

/**
 * Restores the voice archived for the item after its add was refused (the
 * spec's one paid recovery, run inside `carryOut` under the archive row's
 * claim), as a recorded add: an `adding` record with `back`, a fresh token
 * and the inventory, so a lost reply is matched like any add and reconcile
 * can finish the rows. A refusal puts the record back at `archived`.
 */
async function bringBack(
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
      why: `could not list the account's voices before restoring ${voice.display_name}: ${message(err)}`,
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

/** Gives the item back when nothing of the operation remains. */
async function releaseTaskAt(
  client: SupabaseClient,
  item: ItemKey,
  rev: string,
  inserted: boolean,
): Promise<void> {
  if (!inserted) {
    await swapOperation(client, item, { rev }, null);
    return;
  }
  const del = await client
    .from("casting_tasks")
    .delete()
    .eq("book_id", item.bookId)
    .eq("issue_id", item.issueId)
    .eq("character_id", item.characterId)
    .eq("operation->>rev", rev);
  fail(`releasing ${item.characterId}'s casting task`, del.error);
}

async function carryOutClaimed(
  deps: VoiceSlotsDeps,
  item: RunKey,
  opts: { archiveVoiceId: string | null },
  rec: Recorder,
): Promise<CarryOutResult> {
  const sb = deps.supabase;
  const { op, record } = rec;
  const refuse = (...reasons: string[]): CarryOutResult => ({
    status: "refused",
    reasons,
  });
  const { bookId, issueId, characterId } = item;

  // Revalidate under the claim: the plan shows this run's own record.
  const plan = await planVoiceWork(deps, bookId, issueId);
  const fresh = plan.items.find((i) => i.characterId === characterId);
  if (!fresh) return refuse(`${characterId} is no longer voice work here`);
  // By character and target: a restore claimed without a task row reads
  // back as a clone of the same voice, which is the same work.
  if (
    (fresh.action === "design") !== (item.action === "design") ||
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

  /**
   * A design refuses once the character has an active designed voice
   * (appearance null) that did not exist when it was planned: another
   * issue's run made it from the same stored row meanwhile (#458). The
   * voices the owner's plan already showed (`item.designedVoices`) are
   * alternatives he chose past; this re-plan's list is not used, since a
   * competing design may already be in it.
   */
  const planned = new Set(item.designedVoices);
  const alreadyDesigned = async (): Promise<CarryOutResult | null> => {
    if (fresh.action !== "design") return null;
    const made = (await readCharacterVoices(sb, [characterId])).find(
      (v) =>
        v.status === "active" &&
        v.appearance_id === null &&
        !planned.has(v.id) &&
        v.id !== fresh.replaces?.id,
    );
    return made
      ? refuse(
          `${made.display_name} is already an active designed voice for ${characterId}, made since this plan; nothing was spent, pick it as an active voice`,
        )
      : null;
  };

  let description: string | null = null;
  if (fresh.action === "design") {
    const made = await alreadyDesigned();
    if (made) return made;
    const read = async () =>
      (await readDescriptions(sb, [characterId])).get(characterId) ?? null;
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
    // Under the claims and before any spend: the voice may exist by now.
    const made = await alreadyDesigned();
    if (made) return made;
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
      await record({
        phase: "archiving",
        archived: archiveRow.id,
        archivedElevenLabsId: archiveRow.current_elevenlabs_id ?? undefined,
      });
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

    await record({
      phase: "adding",
      before,
      name,
      replaces: fresh.replaces?.id,
    });
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
      const back = await bringBack(deps, rec, archiveRow!, deleteConfirmed);
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
      await record({
        phase: "retiring",
        archived: archiveRow.id,
        archivedElevenLabsId: archiveRow.current_elevenlabs_id ?? undefined,
      });
      let r;
      try {
        r = await archive();
      } catch (err) {
        return {
          status: "needs attention",
          reasons: [
            `the voice ${elevenLabsId} is recorded, but archiving ${archiveRow.display_name} did not finish: ${message(err)}`,
            "the DELETE may have landed; check ElevenLabs, then reconcile",
          ],
          archived,
          newElevenLabsId: elevenLabsId,
        };
      }
      if (deleteConfirmed) {
        await record({ phase: "retired" });
        return {
          status: "needs attention",
          reasons: [
            ...warnings,
            "the DELETE landed but its registry write failed; reconcile finishes it, and Restore in /admin/voices brings the voice back from its recorded DELETE",
          ],
          archived,
          newElevenLabsId: elevenLabsId,
        };
      }
      if (r.ok) didArchive = true;
      else
        warnings.push(`${archiveRow.display_name} was not archived: ${r.why}`);
    }
    // An archive-first DELETE whose registry write failed: the add proves
    // the slot was freed, so finish the rows (DB only).
    if (
      !addFirst &&
      archiveRow &&
      deleteConfirmed &&
      archiveRow.current_elevenlabs_id
    )
      await finishArchive(
        sb,
        archiveRow,
        archiveRow.current_elevenlabs_id,
      ).catch((err: unknown) =>
        warnings.push(
          `${archiveRow.display_name}'s registry write is still unfinished: ${message(err)}`,
        ),
      );
    if (!(await rec.end("in_progress")))
      return {
        status: "needs attention",
        reasons: ["the voice is recorded, but the item's record changed"],
        newElevenLabsId: elevenLabsId,
      };
    return {
      status: "done",
      voiceUuid: saved.voiceUuid,
      elevenLabsId,
      castlistRows: saved.castlistRows,
      archived: didArchive ? (archived ?? null) : null,
      warnings,
    };
  };

  // Claims on the `voices` rows it changes, all taken before anything is
  // spent: the voice archived, the voice that comes back (or, for a design,
  // the voice it replaces), and a design's stored row (#458), which another
  // issue's run may be designing from too. The task-row claim above covers
  // a design that changes no existing row.
  const stored =
    fresh.action === "design" ? await readStoredDesign(sb, characterId) : null;
  const claims: { row: VoiceRow; op: VoiceClaimOperation }[] = [];
  const hold = (row: VoiceRow | null, op: VoiceClaimOperation) => {
    if (row && !claims.some((c) => c.row.id === row.id))
      claims.push({ row, op });
  };
  hold(archiveRow, "archive");
  hold(
    fresh.target ?? (fresh.action === "design" ? fresh.replaces : null),
    fresh.action,
  );
  hold(stored, "design");
  let started = false;
  let claiming: VoiceRow | null = null;
  const claimed = claims.reduceRight<() => Promise<CarryOutResult>>(
    (inner, c) => () => {
      claiming = c.row;
      return withVoiceOperationClaim(sb, c.row, c.op, inner);
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
    // Nothing was spent: another run holds the row, or changed it first.
    return refuse(
      `${(claiming as VoiceRow).display_name} is held by another run (${message(err)}); nothing was spent, plan again once it finishes`,
    );
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
 * its task row. It never spends (decisions row 264): it reads ElevenLabs
 * with free GETs and writes rows. A voice left archived is named in the
 * result for the Restore in `/admin/voices`, which holds the row's claim and
 * runs the bucket-hash guard.
 *
 * - `added`: finishes the rows. `retired`: finishes the outgoing voice's
 *   registry writes, then the rows.
 * - `adding`: adopts the voice carrying the add's token and finishes; with
 *   `notAdded` (the owner checked ElevenLabs) gives the item back.
 * - `archiving` and `retiring`: lists the account once. The DELETE landed
 *   when the archived voice's id is gone: its registry writes are finished.
 * - `claimed`, `archived`, `archiving` and an add-back that is not found:
 *   the item goes back to pending, naming any voice left archived.
 */
export async function reconcile(
  deps: VoiceSlotsDeps,
  item: ItemKey,
  opts: { notAdded?: boolean } = {},
): Promise<CarryOutResult> {
  const sb = deps.supabase;
  const { data, error } = await taskRow(sb, item);
  fail(`reading ${item.characterId}'s casting task`, error);
  const task = (
    (data ?? []) as (TaskRow & { target_voice_uuid?: string })[]
  )[0];
  const op = task?.operation;
  if (!op)
    return {
      status: "refused",
      reasons: [`nothing to reconcile: the item is ${stateOf(task)}`],
    };
  // A live run writes its record as it goes and holds the claim on the
  // voices it changes: leave it be while either is younger than the window.
  if (op.at && Date.parse(op.at) >= Date.now() - CLAIM_STALE_MS)
    return { status: "refused", reasons: ["a run is still in progress"] };
  const held = [op.archived, task.target_voice_uuid, item.target?.id].filter(
    (id): id is string => Boolean(id),
  );
  if (held.length > 0) {
    const claims = await sb
      .from("voices")
      .select("id, operation_claim, operation_claimed_at")
      .in("id", held);
    fail("reading voice claims", claims.error);
    if (
      ((claims.data ?? []) as Parameters<typeof claimHeld>[0][]).some(claimHeld)
    )
      return { status: "refused", reasons: ["a run is still in progress"] };
  }
  const rec = recorder(sb, item, op);
  const archivedRow = op.archived ? await readVoice(sb, op.archived) : null;
  const archived = archivedRow
    ? { id: archivedRow.id, name: archivedRow.display_name }
    : undefined;
  /** The record's DELETE is the one the row still points at. */
  const sameVoice =
    archivedRow !== null &&
    op.archivedElevenLabsId !== undefined &&
    archivedRow.current_elevenlabs_id === op.archivedElevenLabsId;
  const attention = (...reasons: string[]): CarryOutResult => ({
    status: "needs attention",
    reasons,
    archived,
    newElevenLabsId: op.elevenLabsId,
  });
  const changed = () => attention("the item's record changed during reconcile");
  /** The item goes back to pending; nothing is added for it. */
  const giveBack = async (
    why: string,
    ...more: string[]
  ): Promise<CarryOutResult> => {
    if (!(await rec.end("pending"))) return changed();
    const row = archivedRow ? await readVoice(sb, archivedRow.id) : null;
    return {
      status: "failed",
      reasons: [
        why,
        ...more,
        row?.status === "archived"
          ? `${row.display_name} is archived; restore it from /admin/voices`
          : "the item is pending again",
      ],
    };
  };
  const finish = async (elevenLabsId: string): Promise<CarryOutResult> => {
    const plan = await planVoiceWork(deps, item.bookId, item.issueId);
    const fresh = plan.items.find((i) => i.characterId === item.characterId);
    if (!fresh) return attention("the item is gone from the plan");
    // After an archive-first replacement the replaced voice is archived, so
    // the plan no longer names it: take it from the record.
    const replaces =
      fresh.replaces ?? (op.replaces ? await readVoice(sb, op.replaces) : null);
    const description =
      fresh.action === "design"
        ? ((await readDescriptions(sb, [item.characterId])).get(
            item.characterId,
          ) ?? null)
        : null;
    const saved = await recordVoice(
      deps,
      { ...fresh, replaces },
      elevenLabsId,
      description,
      false,
    );
    if (!(await rec.end("in_progress"))) return changed();
    return {
      status: "done",
      voiceUuid: saved.voiceUuid,
      elevenLabsId,
      castlistRows: saved.castlistRows,
      archived: archived ?? null,
      warnings: ["reconciled from the recorded operation"],
    };
  };
  /** Free GET: is the archived voice's id still on the account? */
  const stillThere = async (): Promise<boolean> => {
    const ids = (await listVoices(deps)).map((v) => v.voice_id);
    return ids.includes(op.archivedElevenLabsId ?? "");
  };

  try {
    // Every phase past `archived` proves the archive-first DELETE: finish
    // its registry writes while the row still holds the deleted id.
    if (
      sameVoice &&
      (op.phase === "archived" || op.phase === "adding" || op.phase === "added")
    )
      await finishArchive(sb, archivedRow, op.archivedElevenLabsId!);
    switch (op.phase) {
      case "claimed":
        return await giveBack("nothing was spent");
      case "archived":
        return await giveBack("no voice was made for the item");
      case "archiving":
      case "retiring": {
        if (!archivedRow || !op.archivedElevenLabsId)
          return attention("the record does not name the archived voice");
        let present: boolean;
        try {
          present = await stillThere();
        } catch (err) {
          return attention(`could not list the account: ${message(err)}`);
        }
        if (!present && sameVoice)
          await finishArchive(sb, archivedRow, op.archivedElevenLabsId);
        if (op.phase === "archiving")
          return await giveBack(
            present
              ? `the DELETE of ${archivedRow.display_name} did not land; nothing changed`
              : "no voice was made for the item",
          );
        const done = await finish(op.elevenLabsId!);
        if (done.status !== "done" || !present) return done;
        return {
          ...done,
          archived: null,
          warnings: [
            ...done.warnings,
            `the DELETE of ${archivedRow.display_name} did not land; it stays active`,
          ],
        };
      }
      case "retired":
        if (sameVoice)
          await finishArchive(sb, archivedRow, op.archivedElevenLabsId!);
        return await finish(op.elevenLabsId!);
      case "added":
        return await finish(op.elevenLabsId!);
      case "adding": {
        const found = await matchLostAdd(deps, op);
        if (op.back) {
          // Adopt the restore only while the row still holds the deleted id;
          // a row the owner restored meanwhile is left as it is.
          const adopt =
            archivedRow !== null &&
            (archivedRow.status === "archived" || sameVoice);
          if (found.ok && adopt) await markRestored(sb, archivedRow, found.id);
          if (found.ok && !adopt)
            return await giveBack(
              "no voice was made for the item",
              `${found.id} is a restore of ${archived?.name ?? op.archived} that no row records, since the voice was restored another way; delete it on ElevenLabs by hand`,
            );
          if (found.ok || opts.notAdded)
            return await giveBack("no voice was made for the item");
          return attention(found.why);
        }
        if (!found.ok)
          return opts.notAdded
            ? await giveBack("the owner confirmed the add did not land")
            : attention(found.why);
        await rec.record({ phase: "added", elevenLabsId: found.id });
        return await finish(found.id);
      }
    }
  } catch (err) {
    return attention(`reconcile stopped: ${message(err)}`);
  }
}

export type SettleOutcome =
  /** He accepts the voice `carryOut` made. */
  | { kind: "accept" }
  /** He picks an active voice instead; no slot. */
  | { kind: "pick"; voiceUuid: string }
  /** No audio for this character this run. */
  | { kind: "no audio" }
  /**
   * Runs the item again: a made item goes back to pending, so `carryOut`
   * can make another voice. A clone or restore names the archived voice to
   * try next (`targetVoiceUuid`); a design needs none. The made voice stays
   * active; nothing is archived.
   */
  | { kind: "rerun"; targetVoiceUuid?: string };

/** Settles one item: points the cast at a picked voice or skips the character, then marks its `casting_tasks` row complete; or puts a made item back to pending (`rerun`). */
export async function settle(
  client: SupabaseClient,
  item: ItemKey,
  outcome: SettleOutcome,
): Promise<void> {
  const { data, error } = await taskRow(client, item);
  fail(`reading ${item.characterId}'s casting task`, error);
  const row = ((data ?? []) as TaskRow[])[0];
  const status = row?.status;
  if (row?.operation)
    throw new Error(
      `voice work: ${item.characterId} has an operation to reconcile first`,
    );
  if (
    (outcome.kind === "accept" || outcome.kind === "rerun") &&
    status !== "in_progress"
  )
    throw new Error(
      `voice work: ${item.characterId} has no voice made to ${outcome.kind}`,
    );
  if (outcome.kind === "rerun") {
    const target = outcome.targetVoiceUuid;
    if (item.action !== "design" && !target)
      throw new Error(
        `voice work: a rerun of ${item.characterId}'s ${item.action} names the next voice to try`,
      );
    if (target && !(await readVoice(client, target)))
      throw new Error(`voice work: no voice ${target}`);
    const upd = await client
      .from("casting_tasks")
      .update({
        status: "pending",
        completed_at: null,
        ...(target ? { action: "clone", target_voice_uuid: target } : {}),
      })
      .eq("book_id", item.bookId)
      .eq("issue_id", item.issueId)
      .eq("character_id", item.characterId)
      .eq("status", "in_progress")
      .is("operation", null)
      .select("id");
    fail(`rerunning ${item.characterId}`, upd.error);
    if ((upd.data ?? []).length === 0)
      throw new Error(`voice work: ${item.characterId} changed; plan again`);
    return;
  }
  if (outcome.kind === "pick") {
    const voice = await readVoice(client, outcome.voiceUuid);
    if (voice?.status !== "active")
      throw new Error(
        `voice work: ${outcome.voiceUuid} is not an active voice`,
      );
    await castVoiceInBook(
      client,
      item.bookId,
      item.issueId,
      item.characterId,
      voice.id,
    );
  }
  if (outcome.kind === "no audio")
    // Skip writers set `no_audio` and leave the voice reference alone (#429).
    await setNoAudio(client, item.bookId, item.issueId, item.characterId, true);
  await markTask(client, item, "complete");
}
