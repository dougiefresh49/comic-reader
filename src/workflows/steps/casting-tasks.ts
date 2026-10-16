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
import {
  castRow,
  loadBookCast,
  renderVoice,
  voiceFor,
  type BookCast,
} from "~/lib/cast";

const PAGE = 1000;

/** One line a character speaks in the issue, in reading order. */
export interface SpeakerLine {
  bubbleId: string;
  page: number;
  /** `text_with_cues`, else `ocr_text`. */
  text: string;
  emotion: string | null;
  /** `bubbles.voice_id` (a `voices.id`) of the stored audio; null when the bubble has no audio. */
  audioVoiceId: string | null;
  /**
   * The line needs nothing more (#790's rule, #358): it has no text, or it
   * has audio rendered by the voice the character's render chain names now
   * (`voiceFor`, playable or not). See `lineRendered`.
   */
  rendered: boolean;
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
  /** Speakers with no usable voice, not marked "no audio" and not removed from the issue, as character ids. */
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
   * Characters with a text line that has no audio from their voice, who sit
   * out ("no audio" on their row, not removed) or have no usable voice
   * (#358). The voices stop comes back for them once audio has started.
   */
  leftovers: Leftover[];
  /** Some bubble in the issue has audio: the first audio pass has run. */
  audioStarted: boolean;
}

/** A character whose lines would play nothing (#358). */
export interface Leftover {
  characterId: string;
  /** Text lines with no audio from the character's voice. */
  lines: number;
  /** Sitting out ("no audio"), or no usable voice. */
  why: "sitting out" | "no voice";
}

export interface CreateCastingTasksResult {
  speakers: number;
  cast: number;
  created: number;
  /** Items the voices stop must settle; the gate pauses while above zero. */
  pending: number;
  unresolved: string[];
  /** `plan.leftovers.length`. */
  leftovers: number;
  /** `voicesStopHolds(plan)`: the stop pauses even with nothing pending. */
  holds: boolean;
}

/** Postgres unique_violation; treat as "row already exists". */
function isUniqueViolation(error: { code?: string }): boolean {
  return error.code === "23505";
}

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`[casting] ${what}: ${error.message}`);
}

/**
 * #790's rule, the one home (#358): a line needs nothing more when it has no
 * text (`bubbleNeedsAudio` gives it none), or its stored audio was rendered
 * by `voiceUuid`, the voice the character's render chain names.
 */
export function lineRendered(
  line: Pick<SpeakerLine, "text" | "audioVoiceId">,
  voiceUuid: string | null | undefined,
): boolean {
  if (!line.text) return true;
  return !!voiceUuid && line.audioVoiceId === voiceUuid;
}

/**
 * Every line of the character is rendered and at least one has text: its
 * lines all play, so its voice is no longer needed in this issue (#358). A
 * speaker with no text line keeps today's rules.
 */
export function allLinesRendered(lines: SpeakerLine[] | undefined): boolean {
  if (!lines?.some((l) => l.text)) return false;
  return lines.every((l) => l.rendered);
}

/** Text lines with no audio from the character's voice. */
export function unrenderedLines(lines: SpeakerLine[] | undefined): number {
  return (lines ?? []).filter((l) => !l.rendered).length;
}

/**
 * The one rule that keys speakers to lines (#406), for the voices gate and
 * `planVoiceWork`: each character's lines in the issue's non-ignored,
 * non-silent bubbles, keyed on `bubbles.character_id`, in reading order. A
 * bubble with no `character_id` is unassigned and keys to no one. Each line
 * says whether it is rendered (`lineRendered`) against the chain in `book`,
 * loaded here when the caller has none.
 */
export async function readSpeakerLines(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
  book?: BookCast,
): Promise<Map<string, SpeakerLine[]>> {
  const cast = book ?? (await loadBookCast(client, bookId));
  const lines = new Map<string, SpeakerLine[]>();
  const chainVoice = new Map<string, string | null>();
  const voiceOf = (id: string) => {
    if (!chainVoice.has(id))
      chainVoice.set(id, voiceFor(cast, id, issueId)?.voiceUuid ?? null);
    return chainVoice.get(id)!;
  };
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("bubbles")
      .select(
        "id, page_number, character_id, text_with_cues, ocr_text, emotion, audio_storage_path, voice_id",
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("ignored", false)
      .eq("silent", false)
      .not("character_id", "is", null)
      .order("page_number")
      .order("sort_order")
      .order("id")
      .range(from, from + PAGE - 1);
    fail("reading bubbles", error);
    const page = (data ?? []) as {
      id: string;
      page_number: number;
      character_id: string;
      text_with_cues: string | null;
      ocr_text: string | null;
      emotion: string | null;
      audio_storage_path: string | null;
      voice_id: string | null;
    }[];
    for (const b of page) {
      const list = lines.get(b.character_id) ?? [];
      const line = {
        bubbleId: b.id,
        page: b.page_number,
        text: (b.text_with_cues ?? b.ocr_text ?? "").trim(),
        emotion: b.emotion,
        audioVoiceId: b.audio_storage_path ? b.voice_id : null,
      };
      list.push({
        ...line,
        rendered: lineRendered(line, voiceOf(b.character_id)),
      });
      lines.set(b.character_id, list);
    }
    if (page.length < PAGE) return lines;
  }
}

/**
 * The voices whose every line in this issue is rendered (#358): each
 * speaker the chain gives the voice has `allLinesRendered`. The slot strip's
 * "lines done" mark.
 */
export function voicesWithLinesDone(
  book: BookCast,
  lines: Map<string, SpeakerLine[]>,
  issueId: string,
): Set<string> {
  const done = new Set<string>();
  const notDone = new Set<string>();
  for (const [id, list] of lines) {
    const voice = voiceFor(book, id, issueId)?.voiceUuid;
    if (!voice) continue;
    if (allLinesRendered(list)) done.add(voice);
    else notDone.add(voice);
  }
  for (const v of notDone) done.delete(v);
  return done;
}

/**
 * The leftovers (#358): characters with an unrendered text line who sit out
 * ("no audio", not removed) or have no usable voice. Removed characters and
 * voiced ones are never leftovers; the audio step renders a voiced
 * character's missing lines on its own.
 */
export function leftoversOf(
  book: BookCast,
  lines: Map<string, SpeakerLine[]>,
  issueId: string,
): Leftover[] {
  const out: Leftover[] = [];
  for (const id of [...lines.keys()].sort()) {
    const n = unrenderedLines(lines.get(id));
    if (n === 0) continue;
    const r = renderVoice(book, id, issueId);
    if (r.ok || r.reason === "removed") continue;
    out.push({
      characterId: id,
      lines: n,
      why: r.reason === "no audio" ? "sitting out" : "no voice",
    });
  }
  return out;
}

/**
 * The one voice rule the gate, the pipeline's pause and the voices stop
 * share (#353): a speaker has a voice when the render chain (`renderVoice`)
 * gives it one, meaning an active voice with an ElevenLabs id.
 */
export function hasUsableVoice(
  book: BookCast,
  characterId: string,
  issueId: string,
): boolean {
  return renderVoice(book, characterId, issueId).ok;
}

/** Settled without a voice: the issue's row says "no audio", or the character is removed from the issue. */
export function silencedIn(
  book: BookCast,
  characterId: string,
  issueId: string,
): boolean {
  const found = renderVoice(book, characterId, issueId);
  return (
    !found.ok && (found.reason === "no audio" || found.reason === "removed")
  );
}

/**
 * Why the character's own castlist row in this issue rules out voice work
 * (#429): removed, or "no audio". A voice request for it buys nothing the
 * render chain would play, so it is refused and holds no gate. Null when the
 * row allows voice work (or there is none).
 */
export function ownRowStop(
  book: BookCast,
  characterId: string,
  issueId: string,
): "removed from this issue" | "no audio in this issue" | null {
  const own = castRow(book, characterId, issueId);
  if (own?.in_issue === false) return "removed from this issue";
  if (own?.no_audio) return "no audio in this issue";
  return null;
}

/**
 * Read-only: the issue's voice work as the gate counts it. A speaker is
 * settled when it has a usable voice (`hasUsableVoice`), the issue's
 * castlist row marks it "no audio" or removes it (`silencedIn`), or every
 * line of it is rendered (`allLinesRendered`, #358: an archived voice whose
 * lines all play asks for no restore). A `casting_tasks` row is open while
 * pending or in progress, when it is a request (unless its own row is
 * removed or "no audio", `ownRowStop`), carries a `carryOut` record, or its
 * speaker still has no voice; a stale row for a speaker who has a voice now,
 * or whose lines are all rendered, is not work the voices stop could show,
 * so it never holds the run.
 */
export async function planCastingTasks(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<CastingPlan> {
  const book = await loadBookCast(client, bookId);
  const [lines, tasks, audio] = await Promise.all([
    readSpeakerLines(client, bookId, issueId, book),
    client
      .from("casting_tasks")
      .select("character_id, status, action, operation")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    // select count(*) from bubbles where book_id = $1 and issue_id = $2
    //   and audio_storage_path is not null
    client
      .from("bubbles")
      .select("id", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .not("audio_storage_path", "is", null),
  ]);
  fail("reading casting tasks", tasks.error);
  fail("counting bubbles with audio", audio.error);
  const rows = (tasks.data ?? []) as {
    character_id: string;
    status: string;
    action: string | null;
    operation: unknown;
  }[];

  const ids = [...lines.keys()].sort();
  const voiced = (id: string) => hasUsableVoice(book, id, issueId);
  const done = (id: string) => allLinesRendered(lines.get(id));
  const noVoice = ids.filter(
    (id) => !voiced(id) && !silencedIn(book, id, issueId) && !done(id),
  );
  const unresolved = noVoice.filter((id) => book.resolve(id)?.id !== id);
  const hasRow = new Set(rows.map((r) => r.character_id));
  const open = rows
    .filter(
      (r) =>
        (r.status === "pending" || r.status === "in_progress") &&
        !done(r.character_id) &&
        ((r.action !== null && !ownRowStop(book, r.character_id, issueId)) ||
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
    leftovers: leftoversOf(book, lines, issueId),
    audioStarted: (audio.count ?? 0) > 0,
  };
}

/** Items the voices stop must settle: every open row, plus speakers with no voice and no open row. */
export function pendingFromPlan(plan: CastingPlan): number {
  return plan.unsettled.length;
}

/**
 * Whether the voices stop pauses (#358): while anything is unsettled, or,
 * once some bubble has audio, while any leftover is still there. Before the
 * first audio pass a sitting-out character stays the owner's settled call.
 */
export function voicesStopHolds(
  plan: Pick<CastingPlan, "unsettled" | "leftovers" | "audioStarted">,
): boolean {
  return (
    plan.unsettled.length > 0 ||
    (plan.audioStarted && plan.leftovers.length > 0)
  );
}

/**
 * Option A's loop (#358): after an audio pass, go back to the voices stop
 * while leftovers remain and the last round shrank them. `previous` is the
 * count after the round before, null after the first audio pass.
 */
export function voicesRoundAgain(
  leftovers: number,
  previous: number | null,
): boolean {
  return leftovers > 0 && (previous === null || leftovers < previous);
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
    leftovers: plan.leftovers.length,
    holds: voicesStopHolds(plan),
  };
}

/**
 * Workflow step (#358): the leftovers after an audio pass, the count the
 * voices loop compares round to round. Reads only.
 */
export async function countVoiceLeftovers(
  bookId: string,
  issueId: string,
): Promise<number> {
  "use step";

  const { createStepClient } = await import("../step-utils");
  const client = await createStepClient();
  const plan = await planCastingTasks(client, bookId, issueId);
  return plan.leftovers.length;
}
