/**
 * The `voices` writes and reads the scripts need beyond the rest of the
 * module (#458): voice-lab-import's update and candidate insert, and the
 * smoke run's isolation snapshot and cleanup. Rows are found by id or
 * character id, never by `display_name` (decisions row 153).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "~/types/database";

const PAGE = 1000;
const db = (client: SupabaseClient) => client as SupabaseClient<Database>;

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what}: ${error.message}`);
}

/**
 * The fields voice-lab-import fills on an existing row. `status` moves
 * only to `archived`, when a `needs_clip` row receives its sample.
 */
export type VoiceLabFacts = Partial<{
  description: string;
  labels: Json;
  design_prompt: string;
  starting_pick: boolean;
  consumers: string[];
  source_clip_path: string;
  source_clip_md5: string;
  status: "archived";
}>;

export async function updateVoiceFacts(
  client: SupabaseClient,
  voiceId: string,
  set: VoiceLabFacts,
): Promise<void> {
  const { error } = await db(client)
    .from("voices")
    .update(set)
    .eq("id", voiceId);
  if (error) fail(`update voices ${voiceId}`, error);
}

export interface CandidateVoiceInput {
  display_name: string;
  character_id: string;
  /** Null for a designed voice. */
  appearance_id: string | null;
  description: string;
  labels: Json;
  design_prompt: string | null;
  starting_pick: boolean;
  consumers: string[];
  source_clip_path: string;
  source_clip_md5: string;
}

/** An archived row for a clip stored in the clips bucket and not in a slot. */
export async function insertCandidateVoice(
  client: SupabaseClient,
  input: CandidateVoiceInput,
): Promise<string> {
  const { data, error } = await db(client)
    .from("voices")
    .insert({ ...input, status: "archived", current_elevenlabs_id: null })
    .select("id")
    .single();
  if (error) fail(`insert voices ${input.display_name}`, error);
  return data.id;
}

/** Every `voices` row with every column, ordered by id, for a snapshot. */
export async function readVoiceTable(
  client: SupabaseClient,
): Promise<Database["public"]["Tables"]["voices"]["Row"][]> {
  const rows: Database["public"]["Tables"]["voices"]["Row"][] = [];
  for (;;) {
    const { data, error } = await db(client)
      .from("voices")
      .select("*")
      .order("id")
      .range(rows.length, rows.length + PAGE - 1);
    if (error) fail("read voices", error);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return rows;
  }
}

/**
 * Deletes the voices of these characters that hold no real ElevenLabs id
 * (none, or a DRY_RUN `dry-run-` id). A row holding a real id stays, since
 * deleting it would lose track of a slot; the caller's count then shows it.
 */
export async function deleteFakeCharacterVoices(
  client: SupabaseClient,
  characterIds: string[],
): Promise<void> {
  if (characterIds.length === 0) return;
  const { error } = await db(client)
    .from("voices")
    .delete()
    .in("character_id", characterIds)
    .or("current_elevenlabs_id.is.null,current_elevenlabs_id.like.dry-run-*");
  if (error) fail("delete voices", error);
}
