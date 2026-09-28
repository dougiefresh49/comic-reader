import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "~/types/database";

type VoiceInsert = Database["public"]["Tables"]["voices"]["Insert"];

export interface RegisterCastVoiceInput {
  bookId: string;
  issueId: string;
  characterId: string;
  elevenLabsId: string;
  /** Voice Design prompt; kept for provenance, not regeneration (#96). */
  designPrompt?: string;
}

/**
 * How far a failed save got: `none` wrote no `voices` or castlist row,
 * `voices` wrote or found the voices row (`voiceUuid` when known) but not
 * castlist, `castlist` wrote both but did not complete the casting task.
 */
export type CastSaveFailure = {
  ok: false;
  error: string;
  stage: "none" | "voices" | "castlist";
  voiceUuid?: string;
};

export type RegisterCastVoiceResult =
  | { ok: true; voiceUuid: string }
  | CastSaveFailure;

/** The `voices` insert payload for a castlist voice not registered yet. */
export function buildVoiceRow(
  input: Pick<
    RegisterCastVoiceInput,
    "characterId" | "elevenLabsId" | "designPrompt"
  >,
): VoiceInsert {
  // #91 adds `consumers` ({comic}), `character_id` and `description`
  // (the design prompt). Write them here once its migration is applied.
  // No character display-name column exists, so display_name is the
  // castlist character string, as in the backfilled rows.
  return {
    display_name: input.characterId,
    status: "active",
    current_elevenlabs_id: input.elevenLabsId,
    keep_active: false,
    design_prompt: input.designPrompt ?? null,
  };
}

/**
 * Registers the voice and points castlist at it: finds the `voices` row
 * that owns this ElevenLabs id, or creates one, then upserts the castlist
 * row with both `voice_id` and `voice_uuid`. Takes the client as an
 * argument so a script can run it against a fake one.
 */
export async function registerCastVoice(
  client: SupabaseClient,
  input: RegisterCastVoiceInput,
): Promise<RegisterCastVoiceResult> {
  const db = client as SupabaseClient<Database>;
  const fail = (error: string): CastSaveFailure => ({
    ok: false,
    error,
    stage: "none",
  });

  const findVoice = () =>
    db
      .from("voices")
      .select("id")
      .eq("current_elevenlabs_id", input.elevenLabsId)
      .maybeSingle();

  const { data: existing, error: findErr } = await findVoice();
  if (findErr) return fail(findErr.message);

  let voiceUuid = existing?.id;
  if (!voiceUuid) {
    const { data: inserted, error: insertErr } = await db
      .from("voices")
      .insert(buildVoiceRow(input))
      .select("id")
      .single();
    if (insertErr) {
      // 23505: another write registered this id first (voices_current_el_id_uniq).
      if (insertErr.code !== "23505") return fail(insertErr.message);
      // A failed lookup leaves the winner's row unconfirmed but likely, so
      // stage `voices`; a lookup that finds nothing confirms no row.
      const { data: raced, error: raceErr } = await findVoice();
      if (raceErr)
        return { ok: false, error: raceErr.message, stage: "voices" };
      if (!raced) return fail(insertErr.message);
      voiceUuid = raced.id;
    } else {
      voiceUuid = inserted.id;
    }
  }

  const { error: castErr } = await db.from("castlist").upsert(
    {
      book_id: input.bookId,
      issue_id: input.issueId,
      character: input.characterId,
      voice_id: input.elevenLabsId,
      voice_uuid: voiceUuid,
    },
    { onConflict: "book_id,issue_id,character" },
  );
  if (castErr) {
    return { ok: false, error: castErr.message, stage: "voices", voiceUuid };
  }

  return { ok: true, voiceUuid };
}

/** One sentence per stage, so the reader knows which rows to look for. */
export function castSaveFailureMessage(voiceId: string, f: CastSaveFailure) {
  if (f.stage === "voices") {
    const row = f.voiceUuid ? `voices row ${f.voiceUuid}` : "a voices row";
    return `Voice ${voiceId} has ${row}, but the castlist was not updated (${f.error}).`;
  }
  if (f.stage === "castlist") {
    return `Voice ${voiceId} is registered, but the casting task was not marked complete (${f.error}).`;
  }
  return `Voice ${voiceId} exists in ElevenLabs but was not registered (${f.error}).`;
}
