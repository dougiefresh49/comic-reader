/**
 * The server write the voices stop (#353) needs beyond
 * `~/lib/voice-requests`: clearing "no audio", which `settle` sets but
 * cannot undo.
 */
import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { setNoAudio } from "~/lib/cast";

/**
 * Clears "no audio" for a character in one issue: `no_audio` goes back to
 * false on its castlist row there (the voice reference was never touched),
 * and a settled `casting_tasks` row goes back to pending, so the item is
 * voice work again. No row is ever deleted, so the speaker stays in
 * `getCast`. Returns the rows cleared.
 */
export async function clearNoAudio(
  bookId: string,
  issueId: string,
  characterId: string,
): Promise<number> {
  const rows = await setNoAudio(
    supabaseAdmin,
    bookId,
    issueId,
    characterId,
    false,
  );
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
  return rows;
}
