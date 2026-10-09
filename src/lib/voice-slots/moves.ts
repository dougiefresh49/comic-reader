/**
 * The `voices` writes the casting moves make (#786), kept in the voices
 * module like every other read and write of the table.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readVoice } from "./registry";
import type { VoiceRow } from "./types";

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

/**
 * An active row for another project's voice on the account, so an archive
 * of it has a row for its backup and its `voice_archives` record. No
 * consumer (it is not this repo's) and no character.
 */
export async function registerOutsideVoice(
  supabase: SupabaseClient,
  input: {
    name: string;
    elevenLabsId: string;
    description: string | null;
    labels: Record<string, string> | null;
  },
): Promise<VoiceRow> {
  const { data, error } = await supabase
    .from("voices")
    .insert({
      display_name: input.name,
      status: "active",
      current_elevenlabs_id: input.elevenLabsId,
      description: input.description,
      labels: input.labels,
      consumers: [],
      character_id: null,
    })
    .select("id")
    .single();
  fail("insert voices", error);
  const row = await readVoice(supabase, (data as { id: string }).id);
  if (!row) throw new Error(`insert voices: no row for ${input.elevenLabsId}`);
  return row;
}

/** Sets the row's labels (an archive's backup step fills missing ones). */
export async function writeVoiceLabels(
  supabase: SupabaseClient,
  voiceId: string,
  labels: Record<string, string>,
): Promise<void> {
  const { error } = await supabase
    .from("voices")
    .update({ labels })
    .eq("id", voiceId);
  fail("update voices labels", error);
}

/** Files the voice under the character, only while it has none. */
export async function fileVoiceUnder(
  supabase: SupabaseClient,
  voiceId: string,
  characterId: string,
): Promise<void> {
  const { error } = await supabase
    .from("voices")
    .update({ character_id: characterId })
    .eq("id", voiceId)
    .is("character_id", null);
  fail(`filing ${voiceId} under ${characterId}`, error);
}

/** Marks a voice made for one issue's run (`voices.run_only`). */
export async function markRunOnly(
  supabase: SupabaseClient,
  voiceId: string,
): Promise<void> {
  const { error } = await supabase
    .from("voices")
    .update({ run_only: true })
    .eq("id", voiceId);
  fail(`marking ${voiceId} run only`, error);
}

/** The operation claims on these rows, for a reconcile's "still in progress" test. */
export async function readVoiceClaims(
  supabase: SupabaseClient,
  ids: string[],
): Promise<
  { operation_claim: string | null; operation_claimed_at: string | null }[]
> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("voices")
    .select("operation_claim, operation_claimed_at")
    .in("id", ids);
  fail("reading voice claims", error);
  return (data ?? []) as {
    operation_claim: string | null;
    operation_claimed_at: string | null;
  }[];
}
