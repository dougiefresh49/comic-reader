/**
 * Reads each voice's `voices.voice_settings` for the TTS request (#412). Its
 * own module, apart from the pure `voice-settings.ts` and from the workflow
 * steps, so the audio step, the server actions and the scripts all import the
 * one read.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "~/types/database";
import { parseVoiceOverride, type VoiceOverride } from "~/lib/voice-settings";

type Client = SupabaseClient;
const db = (client: Client) => client as SupabaseClient<Database>;

/**
 * The parsed override for each ElevenLabs voice id, keyed by that id. Looked
 * up by `current_elevenlabs_id`, the id every call site already holds; an id
 * with no `voices` row is absent from the map and gets no override. Throws on
 * a stored value `parseVoiceOverride` rejects, and when two rows share an id,
 * since either would be a guess at which settings to pay for.
 */
export async function loadVoiceOverrides(
  client: Client,
  elevenLabsIds: string[],
): Promise<Map<string, VoiceOverride>> {
  const out = new Map<string, VoiceOverride>();
  const ids = [...new Set(elevenLabsIds)];
  if (ids.length === 0) return out;
  const { data, error } = await db(client)
    .from("voices")
    .select("id, current_elevenlabs_id, voice_settings")
    .in("current_elevenlabs_id", ids);
  if (error)
    throw new Error(`voice settings: reading voices: ${error.message}`);
  for (const row of data ?? []) {
    const elId = row.current_elevenlabs_id;
    if (!elId) continue;
    if (out.has(elId)) {
      throw new Error(
        `voice settings: two voices rows have current_elevenlabs_id ${elId}`,
      );
    }
    out.set(
      elId,
      parseVoiceOverride(row.voice_settings, `voices ${row.id} voice_settings`),
    );
  }
  return out;
}
