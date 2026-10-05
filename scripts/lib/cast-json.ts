/**
 * Writes a legacy `castlist.json` (character name -> ElevenLabs id, from the
 * old local pipeline) into the castlist through `~/lib/cast` (#429): each
 * name is resolved to its `characters` row, each ElevenLabs id to the
 * `voices` row that holds it, and the issue's row points at that voice. A
 * name or an id the database does not know is reported and left out.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBookCast, setIssueVoice } from "~/lib/cast";
import { readVoicesByElevenLabsIds } from "~/lib/voice-slots/lookup";

export async function importCastJson(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
  castData: Record<string, string>,
): Promise<{ written: number; skipped: string[] }> {
  const entries = Object.entries(castData);
  if (entries.length === 0) return { written: 0, skipped: [] };
  const book = await loadBookCast(client, bookId);
  const voices = await readVoicesByElevenLabsIds(
    client,
    entries.map(([, id]) => id),
  );
  const voiceByElevenLabs = new Map(
    voices.map((v) => [v.current_elevenlabs_id, v.id]),
  );
  let written = 0;
  const skipped: string[] = [];
  for (const [name, elevenLabsId] of entries) {
    const characterId = book.resolve(name)?.id;
    const voiceUuid = voiceByElevenLabs.get(elevenLabsId);
    if (!characterId || !voiceUuid) {
      skipped.push(
        `${name} (${characterId ? "" : "no characters row"}${!characterId && !voiceUuid ? ", " : ""}${voiceUuid ? "" : `no voices row for ${elevenLabsId}`})`,
      );
      continue;
    }
    await setIssueVoice(client, bookId, issueId, characterId, voiceUuid);
    written++;
  }
  return { written, skipped };
}
