/**
 * Server reads and the one write the voices stop (#353) needs beyond
 * `~/lib/voice-requests`: the issues with open voice work (for
 * `/admin/characters/casting` without a book and issue), and clearing the
 * "no audio this run" marker, which `settle` sets but has no outcome to undo.
 */
import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { loadBookCast } from "~/lib/cast";
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

/**
 * Clears "no audio this run" for a character in one issue: its skip-marked
 * castlist rows there get no voice (so `voiceFor` falls back to the book's
 * other issues, or finds none), and a settled `casting_tasks` row goes back
 * to pending, so the item is voice work again. Returns the rows cleared.
 */
export async function clearNoAudio(
  bookId: string,
  issueId: string,
  characterId: string,
): Promise<number> {
  const book = await loadBookCast(supabaseAdmin, bookId);
  const known = book.resolve(characterId)?.id === characterId;
  const rows = book.rows.filter(
    (r) =>
      r.issue_id === issueId &&
      r.voice_id === SKIPPED_VOICE &&
      (r.character_id ??
        book.resolve(r.character)?.id ??
        slugify(r.character)) === characterId,
  );
  for (const row of rows) {
    const { error } = await supabaseAdmin
      .from("castlist")
      .update({
        voice_id: null,
        voice_uuid: null,
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
