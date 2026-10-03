/**
 * The casting gate's work list (#353): the issue's speakers, which of them
 * have no voice, and which `casting_tasks` rows are still open. The voices
 * stop (`/admin/<book>/<issue>/review/characters/voices`) is where the owner
 * settles them; `canContinueVoices` and the pipeline's pause read the same
 * plan, so the screen, the resume route and the gate agree.
 *
 * The castlist is no longer copied forward here: `seedCast` does that at the
 * characters stop. Request rows (`action` set) are never written here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBookCast, voiceFor, type BookCast } from "~/lib/cast";
import { buildAliasMap, speakerKey } from "./audio-plan";
import { skippedIn } from "./voice";

const PAGE = 1000;

/** One line a character speaks in the issue, in reading order. */
export interface SpeakerLine {
  bubbleId: string;
  page: number;
  /** `text_with_cues`, else `ocr_text`. */
  text: string;
  emotion: string | null;
}

/** An unsettled `casting_tasks` row. */
export interface OpenTask {
  characterId: string;
  status: string;
  /** A voice request (`action` set) from the characters stop. */
  request: boolean;
  /** A `carryOut` is recorded on the row: "needs attention". */
  operation: boolean;
}

export interface CastingPlan {
  /** Distinct speakers in the issue's non-ignored, non-silent bubbles. */
  speakers: number;
  /** Speakers with a usable voice (`hasUsableVoice`). */
  cast: number;
  /** Speakers with no usable voice and no skip marker, as character ids (or speaker keys). */
  noVoice: string[];
  /** Of `noVoice`, the ones no `characters` row knows: they get no task row. */
  unresolved: string[];
  /** Of `noVoice`, the ones with a `characters` row and no task row yet. */
  toCreate: string[];
  /** Pending or in-progress rows that are still voice work (see `planCastingTasks`). */
  open: OpenTask[];
  /** Every character the voices stop must settle: `open` rows and `noVoice` speakers. */
  unsettled: string[];
  /**
   * Always empty since #353: `seedCast` copies the castlist forward. Kept so
   * `scripts/check-casting-plan.ts` still reads.
   */
  toCopy: { character: string }[];
}

export interface CreateCastingTasksResult {
  speakers: number;
  cast: number;
  created: number;
  /** Items the voices stop must settle; the gate pauses while above zero. */
  pending: number;
  unresolved: string[];
}

/** Postgres unique_violation; treat as "row already exists". */
function isUniqueViolation(error: { code?: string }): boolean {
  return error.code === "23505";
}

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`[casting] ${what}: ${error.message}`);
}

/**
 * Each speaker's lines in the issue, keyed as `planVoiceWork` keys them:
 * `bubbles.character_id`, else the speaker through the aliases, resolved to
 * a `characters.id` when a row knows the name.
 */
export async function readSpeakerLines(
  client: SupabaseClient,
  book: BookCast,
  bookId: string,
  issueId: string,
): Promise<Map<string, SpeakerLine[]>> {
  const aliasRes = await client
    .from("aliases")
    .select("alias, canonical")
    .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`);
  fail("reading aliases", aliasRes.error);
  const aliasMap = buildAliasMap(
    (aliasRes.data ?? []) as { alias: string; canonical: string }[],
  );
  const lines = new Map<string, SpeakerLine[]>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("bubbles")
      .select(
        "id, page_number, character_id, speaker, text_with_cues, ocr_text, emotion",
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("ignored", false)
      .eq("silent", false)
      .order("page_number")
      .order("sort_order")
      .order("id")
      .range(from, from + PAGE - 1);
    fail("reading bubbles", error);
    const page = (data ?? []) as {
      id: string;
      page_number: number;
      character_id: string | null;
      speaker: string | null;
      text_with_cues: string | null;
      ocr_text: string | null;
      emotion: string | null;
    }[];
    for (const b of page) {
      const key =
        b.character_id ??
        (b.speaker?.trim() ? speakerKey(b.speaker, aliasMap) : null);
      if (!key) continue;
      const id = book.resolve(key)?.id ?? key;
      const list = lines.get(id) ?? [];
      list.push({
        bubbleId: b.id,
        page: b.page_number,
        text: (b.text_with_cues ?? b.ocr_text ?? "").trim(),
        emotion: b.emotion,
      });
      lines.set(id, list);
    }
    if (page.length < PAGE) return lines;
  }
}

/** `voices.status` for every voice the book's castlist points at. */
export async function readCastVoiceStatus(
  client: SupabaseClient,
  book: BookCast,
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      book.rows.map((r) => r.voice_uuid).filter((id): id is string => !!id),
    ),
  ];
  const status = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await client
      .from("voices")
      .select("id, status")
      .in("id", ids.slice(i, i + 200));
    fail("reading voice status", error);
    for (const v of (data ?? []) as { id: string; status: string }[])
      status.set(v.id, v.status);
  }
  return status;
}

/**
 * The one voice rule the gate, the pipeline's pause and the voices stop
 * share (#353): a speaker has a voice when `voiceFor` finds one with an
 * ElevenLabs id, and the `voices` row it points at, if any, is active. A
 * castlist voice that is archived (or has no ElevenLabs id) is no voice.
 */
export function hasUsableVoice(
  book: BookCast,
  voiceStatus: Map<string, string>,
  characterId: string,
  issueId: string,
): boolean {
  const v = voiceFor(book, characterId, issueId);
  if (!v?.voiceId) return false;
  return !v.voiceUuid || voiceStatus.get(v.voiceUuid) === "active";
}

/**
 * Read-only: the issue's voice work as the gate counts it. A speaker is
 * settled when it has a usable voice (`hasUsableVoice`) or the issue's
 * castlist marks it "no audio this run" (the skip marker). A
 * `casting_tasks` row is open while pending or in progress, when it is a
 * request, carries a `carryOut` record, or its speaker still has no voice; a
 * stale row for a speaker who has a voice now is not work the voices stop
 * could show, so it never holds the run.
 */
export async function planCastingTasks(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<CastingPlan> {
  const book = await loadBookCast(client, bookId);
  const [lines, tasks, voiceStatus] = await Promise.all([
    readSpeakerLines(client, book, bookId, issueId),
    client
      .from("casting_tasks")
      .select("character_id, status, action, operation")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    readCastVoiceStatus(client, book),
  ]);
  fail("reading casting tasks", tasks.error);
  const rows = (tasks.data ?? []) as {
    character_id: string;
    status: string;
    action: string | null;
    operation: unknown;
  }[];

  const ids = [...lines.keys()].sort();
  const voiced = (id: string) => hasUsableVoice(book, voiceStatus, id, issueId);
  const noVoice = ids.filter(
    (id) => !voiced(id) && !skippedIn(book, id, issueId),
  );
  const unresolved = noVoice.filter((id) => book.resolve(id)?.id !== id);
  const hasRow = new Set(rows.map((r) => r.character_id));
  const open = rows
    .filter(
      (r) =>
        (r.status === "pending" || r.status === "in_progress") &&
        (r.action !== null ||
          r.operation !== null ||
          noVoice.includes(r.character_id)),
    )
    .map((r) => ({
      characterId: r.character_id,
      status: r.status,
      request: r.action !== null,
      operation: r.operation !== null,
    }));
  return {
    speakers: ids.length,
    cast: ids.filter(voiced).length,
    noVoice,
    unresolved,
    toCreate: noVoice.filter(
      (id) => !unresolved.includes(id) && !hasRow.has(id),
    ),
    open,
    unsettled: [
      ...new Set([...open.map((t) => t.characterId), ...noVoice]),
    ].sort(),
    toCopy: [],
  };
}

/** Items the voices stop must settle: every open row, plus speakers with no voice and no open row. */
export function pendingFromPlan(plan: CastingPlan): number {
  return plan.unsettled.length;
}

/**
 * Workflow step: a `casting_tasks` row for every speaker in the issue with
 * no voice (request rows and every existing row left alone), and the count
 * the gate pauses on.
 */
export async function createCastingTasks(
  bookId: string,
  issueId: string,
): Promise<CreateCastingTasksResult> {
  "use step";

  const { createStepClient } = await import("../step-utils");
  const client = await createStepClient();
  const plan = await planCastingTasks(client, bookId, issueId);

  let created = 0;
  for (const characterId of plan.toCreate) {
    const { error } = await client.from("casting_tasks").insert({
      book_id: bookId,
      issue_id: issueId,
      character_id: characterId,
      status: "pending",
    });
    if (error) {
      // Unique on (book_id, issue_id, character_id): a row already exists.
      if (isUniqueViolation(error)) continue;
      throw new Error(
        `[casting] casting_task ${characterId}: ${error.message}`,
      );
    }
    created++;
  }

  return {
    speakers: plan.speakers,
    cast: plan.cast,
    created,
    pending: pendingFromPlan(plan),
    unresolved: plan.unresolved,
  };
}
