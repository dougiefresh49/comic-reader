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
import {
  ElevenLabsHeadroomError,
  ElevenLabsRefusedError,
  archiveRefusals,
  archiveVoice,
  designVoice,
  findUnknownVoicesNamed,
  issueNeeds,
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

/** `made`: the voice exists, waiting on `settle`. */
export type VoiceWorkState = "pending" | "made" | "settled";

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

function stateOf(status: string | undefined): VoiceWorkState {
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
      target: first ? (voiceById.get(first.id) ?? null) : null,
      replaces: null,
    });
  }

  const descriptions = await readDescriptions(
    sb,
    items.filter((i) => i.action === "design").map((i) => i.characterId),
  );
  for (const item of items) {
    if (item.state !== "pending") continue;
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
    item.needsSlot = item.refusals.length === 0;
  }

  // The whole list planned together: items that replace a voice give that
  // voice back; the rest take a free slot, then the policy's picks.
  const slotItems = items.filter((i) => i.needsSlot);
  const others = slotItems.filter((i) => !i.replaces);
  const free = await planFreeSlots(deps, others.length, { bookId, issueId });
  let freeLeft = free.freeNow;
  let pickAt = 0;
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
  for (const item of others) {
    if (freeLeft > 0) {
      item.outgoing = { kind: "free slot" };
      freeLeft--;
      continue;
    }
    const voice = free.pick[pickAt++];
    if (!voice) {
      item.outgoing = null;
      continue;
    }
    item.outgoing = {
      kind: "archive",
      voice,
      order: "archive first",
      refusals: [],
      leavesWithoutVoice: leaves(voice, item),
    };
  }
  for (const item of slotItems.filter((i) => i.replaces)) {
    const old = item.replaces!;
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
  /** Stopped with something uncertain; nothing more was changed. */
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

/** Upserts the item's `casting_tasks` row to `status`; inserts one for a speaker with no request. */
async function markTask(
  client: SupabaseClient,
  item: Pick<
    VoiceWorkItem,
    "bookId" | "issueId" | "characterId" | "action" | "target"
  >,
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
 * Performs one item of the issue's voice work. `archiveVoiceId` is the only
 * voice it may archive (null: use a free slot). Re-plans first and refuses
 * when the item changed, is not pending, or is refused; checks headroom
 * before anything is archived; holds the operation claim on every `voices`
 * row it changes; never retries a request. When the add is refused after an
 * archive, the archived voice is restored from its bucket copy; when an
 * add's reply is lost, the new voice is looked up on ElevenLabs, and when
 * that cannot tell, it stops with "needs attention".
 */
export async function carryOut(
  deps: VoiceSlotsDeps,
  item: Pick<
    VoiceWorkItem,
    "bookId" | "issueId" | "characterId" | "action" | "target"
  >,
  opts: { archiveVoiceId: string | null },
): Promise<CarryOutResult> {
  const sb = deps.supabase;
  const refuse = (...reasons: string[]): CarryOutResult => ({
    status: "refused",
    reasons,
  });
  const { bookId, issueId, characterId } = item;

  const plan = await planVoiceWork(deps, bookId, issueId);
  const fresh = plan.items.find((i) => i.characterId === characterId);
  if (!fresh) return refuse(`${characterId} is no longer voice work here`);
  if (
    fresh.action !== item.action ||
    (fresh.target?.id ?? null) !== (item.target?.id ?? null)
  )
    return refuse("the item changed since its plan; plan again");
  if (fresh.state !== "pending") return refuse(`the item is ${fresh.state}`);
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
    const refused = await archiveRefusals(deps, archiveRow, { needs });
    if (refused.length > 0)
      return refuse(
        `${archiveRow.display_name} cannot be archived: ${refused.join(", ")}`,
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

  const name = fresh.target?.display_name ?? fresh.name;
  const archived = archiveRow
    ? { id: archiveRow.id, name: archiveRow.display_name }
    : undefined;

  const add = async (): Promise<Added> => {
    if (fresh.action === "design") {
      try {
        const r = await designVoice(deps, {
          name,
          description: description!,
          meta: { step: "voices-stop", bookId, issueId },
        });
        return { kind: "added", elevenLabsId: r.voice_id, recorded: false };
      } catch (err) {
        return classify(err);
      }
    }
    try {
      const r = await restoreVoice(deps, fresh.target!, { execute: true });
      if (!r.executed || !r.newElevenLabsId)
        return { kind: "refused", reason: r.refusals.join(", ") };
      return { kind: "added", elevenLabsId: r.newElevenLabsId, recorded: true };
    } catch (err) {
      return classify(err);
    }
  };

  const run = async (): Promise<CarryOutResult> => {
    const warnings: string[] = [];
    let didArchive = false;
    if (!addFirst && archiveRow) {
      try {
        const r = await archiveVoice(deps, archiveRow, {
          needs,
          execute: true,
        });
        if (!r.executed)
          return refuse(
            `${archiveRow.display_name} cannot be archived: ${r.refusals.join(", ")}`,
          );
        didArchive = true;
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
    }

    let added = await add();
    if (added.kind === "refused") {
      if (!didArchive) return { status: "failed", reasons: [added.reason] };
      try {
        const back = await readVoice(sb, archiveRow!.id);
        const r = back
          ? await restoreVoice(deps, back, { execute: true })
          : null;
        if (r?.executed)
          return {
            status: "failed",
            reasons: [added.reason],
            restored: archiveRow!.display_name,
          };
        return {
          status: "needs attention",
          reasons: [
            added.reason,
            `restoring ${archiveRow!.display_name} was refused: ${r?.refusals.join(", ") ?? "row not found"}`,
          ],
          archived,
        };
      } catch (err) {
        return {
          status: "needs attention",
          reasons: [
            added.reason,
            `restoring ${archiveRow!.display_name} did not finish: ${message(err)}`,
          ],
          archived,
        };
      }
    }
    if (added.kind === "uncertain") {
      let found: string[] = [];
      let lookup = "";
      try {
        const known = new Set(
          (await readVoices(sb))
            .map((v) => v.current_elevenlabs_id)
            .filter((id): id is string => Boolean(id)),
        );
        found = await findUnknownVoicesNamed(deps, name, known);
      } catch (err) {
        lookup = `the lookup failed: ${message(err)}`;
      }
      if (found.length !== 1)
        return {
          status: "needs attention",
          reasons: [
            `the add's reply was lost: ${added.reason}`,
            lookup ||
              (found.length === 0
                ? `no unregistered ElevenLabs voice named "${name}"`
                : `${found.length} unregistered ElevenLabs voices named "${name}"`),
            "nothing was retried and nothing more was changed",
          ],
          archived: didArchive ? archived : undefined,
        };
      warnings.push(
        `the add's reply was lost (${added.reason}); found the new voice ${found[0]} on ElevenLabs`,
      );
      added = { kind: "added", elevenLabsId: found[0]!, recorded: false };
    }

    const elevenLabsId = added.elevenLabsId;
    let voiceUuid: string;
    let castlistRows: number;
    try {
      if (fresh.action === "design") {
        voiceUuid = await registerVoice(sb, {
          display_name: name,
          current_elevenlabs_id: elevenLabsId,
          description,
          labels: null,
          source_clip_path: null,
          source_clip_md5: null,
          character_id: characterId,
          design_prompt: description,
        });
      } else {
        voiceUuid = fresh.target!.id;
        if (!added.recorded)
          await markRestored(sb, fresh.target!, elevenLabsId);
        const own = await sb
          .from("voices")
          .update({ character_id: characterId })
          .eq("id", voiceUuid)
          .is("character_id", null);
        fail(`filing ${voiceUuid} under ${characterId}`, own.error);
      }
      if (fresh.replaces) {
        // #114 decision 2: the new voice carries the replaced one's metadata.
        const copy = await sb
          .from("voices")
          .update({
            description: fresh.replaces.description,
            labels: fresh.replaces.labels,
          })
          .eq("id", voiceUuid);
        fail(`copying ${fresh.replaces.display_name}'s metadata`, copy.error);
      }
      castlistRows = await castVoice(
        sb,
        bookId,
        issueId,
        characterId,
        voiceUuid,
      );
      await markTask(sb, fresh, "in_progress");
    } catch (err) {
      return {
        status: "needs attention",
        reasons: [
          `the voice ${elevenLabsId} exists on ElevenLabs, but recording it failed: ${message(err)}`,
          "do not run the item again; fix the rows by hand",
        ],
        archived: didArchive ? archived : undefined,
        newElevenLabsId: elevenLabsId,
      };
    }

    if (addFirst && archiveRow) {
      try {
        const r = await archiveVoice(deps, archiveRow, {
          needs,
          execute: true,
        });
        if (r.executed) didArchive = true;
        else
          warnings.push(
            `${archiveRow.display_name} was not archived: ${r.refusals.join(", ")}`,
          );
      } catch (err) {
        warnings.push(
          `archiving ${archiveRow.display_name} did not finish (${message(err)}); it may have landed, check ElevenLabs before archiving it again`,
        );
      }
    }
    return {
      status: "done",
      voiceUuid,
      elevenLabsId,
      castlistRows,
      archived: didArchive ? (archived ?? null) : null,
      warnings,
    };
  };

  // Claims: the voice archived, and the voice that comes back (or, for a
  // design, the voice it replaces). A design with neither has no row to hold.
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

export type SettleOutcome =
  /** He accepts the voice `carryOut` made. */
  | { kind: "accept" }
  /** He picks an active voice instead; no slot. */
  | { kind: "pick"; voiceUuid: string }
  /** No audio for this character this run. */
  | { kind: "no audio" };

/** Settles one item: marks its `casting_tasks` row complete, after pointing the cast at a picked voice. */
export async function settle(
  client: SupabaseClient,
  item: Pick<
    VoiceWorkItem,
    "bookId" | "issueId" | "characterId" | "action" | "target"
  >,
  outcome: SettleOutcome,
): Promise<void> {
  if (outcome.kind === "accept") {
    const tasks = await readTasks(client, item.bookId, item.issueId);
    if (tasks.get(item.characterId) !== "in_progress")
      throw new Error(
        `voice work: ${item.characterId} has no voice made to accept`,
      );
  }
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
  await markTask(client, item, "complete");
}
