/**
 * Server reads and the writes the voices stop (#353) needs beyond
 * `~/lib/voice-requests`: the issues with open voice work (for
 * `/admin/characters/casting` without a book and issue), "no audio this
 * run" for a speaker no `characters` row knows (which `settle` cannot
 * take), and clearing the marker, which `settle` sets but cannot undo.
 */
import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { loadBookCast, type BookCast } from "~/lib/cast";
import {
  hasUsableVoice,
  readCastVoiceStatus,
} from "~/workflows/steps/casting-tasks";
import { slugify } from "~/lib/character-id";
import { SKIPPED_VOICE } from "~/lib/voice-settings";

export interface IssueWithVoiceWork {
  bookId: string;
  issueId: string;
  open: number;
}

/** Issues with a pending or in-progress `casting_tasks` row, most open first. */
export async function issuesWithVoiceWork(): Promise<IssueWithVoiceWork[]> {
  const { data, error } = await supabaseAdmin
    .from("casting_tasks")
    .select("book_id, issue_id")
    .in("status", ["pending", "in_progress"]);
  if (error) throw new Error(`casting: reading open tasks: ${error.message}`);
  const counts = new Map<string, IssueWithVoiceWork>();
  for (const r of (data ?? []) as { book_id: string; issue_id: string }[]) {
    const key = `${r.book_id}/${r.issue_id}`;
    const entry = counts.get(key) ?? {
      bookId: r.book_id,
      issueId: r.issue_id,
      open: 0,
    };
    entry.open++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.open - a.open);
}

/** The issue's castlist rows for a character or speaker key, matched as `cast.ts` matches them. */
function issueRows(book: BookCast, issueId: string, characterId: string) {
  return book.rows.filter(
    (r) =>
      r.issue_id === issueId &&
      (r.character_id ??
        book.resolve(r.character)?.id ??
        slugify(r.character)) === characterId,
  );
}

/** The speaker key now names a `characters` row (any hit, even a different id): the screen is stale. */
function staleKey(book: BookCast, speakerKey: string): Error | null {
  const hit = book.resolve(speakerKey);
  return hit
    ? new Error(
        `"${speakerKey}" now names the character ${hit.display_name ?? hit.id}. Reload the page.`,
      )
    : null;
}

/**
 * "No audio this run" for a speaker no `characters` row knows (owner answer
 * O1 = C on #353): the skip marker on its castlist rows in this issue, under
 * the speaker key, the row `acceptUnresolvedAsSilent` used to write. It does
 * not go through `settle`, which needs a `characters` row for `addToCast`
 * and for the `casting_tasks` row it writes. Only `voice_id` changes, so a
 * row's `voice_uuid` is kept (#346: a voice link is never dropped); a row is
 * inserted only when the issue has none.
 */
export async function markNoAudioUnknown(
  bookId: string,
  issueId: string,
  speakerKey: string,
): Promise<void> {
  const book = await loadBookCast(supabaseAdmin, bookId);
  const stale = staleKey(book, speakerKey);
  if (stale) throw stale;
  const voiceStatus = await readCastVoiceStatus(supabaseAdmin, book);
  const rows = issueRows(book, issueId, speakerKey);
  // Every row the update writes, not only the one `voiceFor` picks: a row
  // with a live voice (an ElevenLabs id whose voice is not archived) is
  // never overwritten.
  const live = rows.some(
    (r) =>
      r.voice_id !== null &&
      r.voice_id !== SKIPPED_VOICE &&
      (!r.voice_uuid || voiceStatus.get(r.voice_uuid) !== "archived"),
  );
  if (live || hasUsableVoice(book, voiceStatus, speakerKey, issueId))
    throw new Error(`casting: ${speakerKey} has a voice in this issue`);
  const { error } =
    rows.length > 0
      ? await supabaseAdmin
          .from("castlist")
          .update({ voice_id: SKIPPED_VOICE })
          .eq("book_id", bookId)
          .eq("issue_id", issueId)
          .in(
            "character",
            rows.map((r) => r.character),
          )
      : await supabaseAdmin.from("castlist").insert({
          book_id: bookId,
          issue_id: issueId,
          character: speakerKey,
          voice_id: SKIPPED_VOICE,
          voice_uuid: null,
        });
  if (error)
    throw new Error(`casting: no audio for ${speakerKey}: ${error.message}`);
}

/**
 * Clears "no audio this run" for a character in one issue: its skip-marked
 * castlist rows there get no voice (so `voiceFor` falls back to the book's
 * other issues, or finds none), and a settled `casting_tasks` row goes back
 * to pending, so the item is voice work again. `voice_uuid` is kept; the
 * `voice_id` the marker replaced is not recorded anywhere, so it goes back
 * to null. No row is ever deleted, so the speaker stays in `getCast`; the
 * next "No audio" updates the row instead of inserting one. Returns the
 * rows cleared.
 */
export async function clearNoAudio(
  bookId: string,
  issueId: string,
  characterId: string,
): Promise<number> {
  const book = await loadBookCast(supabaseAdmin, bookId);
  const known = book.resolve(characterId)?.id === characterId;
  const rows = issueRows(book, issueId, characterId).filter(
    (r) => r.voice_id === SKIPPED_VOICE,
  );
  for (const row of rows) {
    const { error } = await supabaseAdmin
      .from("castlist")
      .update({
        voice_id: null,
        ...(known ? { character_id: characterId } : {}),
      })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("character", row.character)
      .eq("voice_id", SKIPPED_VOICE);
    if (error)
      throw new Error(
        `casting: clearing no audio for ${characterId}: ${error.message}`,
      );
  }
  // `operation` (#351) is not in database.ts yet, so the filter goes untyped.
  const { error } = await supabaseAdmin
    .from("casting_tasks")
    .update({ status: "pending", completed_at: null })
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("character_id", characterId)
    .in("status", ["complete", "skipped"])
    .filter("operation", "is", null);
  if (error)
    throw new Error(
      `casting: reopening ${characterId}'s casting task: ${error.message}`,
    );
  return rows.length;
}
