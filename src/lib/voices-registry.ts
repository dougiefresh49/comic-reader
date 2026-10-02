import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { slugify } from "~/lib/character-id";
import { SKIPPED_VOICE } from "~/lib/voice-settings";
import type { Database } from "~/types/database";
import {
  buildAliasMap,
  buildCastIndex,
  planCharactersNeedingVoices,
  readPlanningAppearances,
  speakerKeys,
  voiceDesignAppearanceId,
} from "~/workflows/steps/audio-plan";
import { isDryRun } from "./fakes/dry-run";

type VoiceInsert = Database["public"]["Tables"]["voices"]["Insert"];
type Db = SupabaseClient<Database>;

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
  // No character display-name column exists, so display_name is the
  // castlist character string, as in the backfilled rows.
  return {
    display_name: input.characterId,
    character_id: input.characterId,
    status: "active",
    current_elevenlabs_id: input.elevenLabsId,
    keep_active: false,
    consumers: ["comic"],
    design_prompt: input.designPrompt ?? null,
  };
}

/**
 * The `voices` row this castlist character already points at, or null.
 * Looks the row up by its id, never by `display_name` (row 153: an
 * import candidate row can carry a live voice's name). The castlist row is
 * the issue's row for the character, by `character_id` or by its text.
 */
export async function findRegisteredVoice(
  client: SupabaseClient,
  input: Pick<RegisterCastVoiceInput, "bookId" | "issueId" | "characterId">,
): Promise<{
  id: string;
  current_elevenlabs_id: string | null;
} | null> {
  const db = client as Db;
  const { data: cast, error: castErr } = await db
    .from("castlist")
    .select("voice_uuid")
    .eq("book_id", input.bookId)
    .eq("issue_id", input.issueId)
    .or(
      `character_id.eq.${input.characterId},character.eq.${input.characterId}`,
    )
    .not("voice_uuid", "is", null)
    .limit(1);
  if (castErr) throw new Error(castErr.message);
  const voiceUuid = cast?.[0]?.voice_uuid;
  if (!voiceUuid) return null;

  const { data: voice, error: voiceErr } = await db
    .from("voices")
    .select("id, current_elevenlabs_id")
    .eq("id", voiceUuid)
    .maybeSingle();
  if (voiceErr) throw new Error(voiceErr.message);
  return voice ?? null;
}

/**
 * Registers the voice and points castlist at it: finds the `voices` row
 * that owns this ElevenLabs id, or creates one, then upserts the castlist
 * row with both `voice_id` and `voice_uuid`. Both writes set
 * `character_id`; a found row gets it only when it has none. Takes the
 * client as an argument so a script can run it against a fake one; `dryRun`
 * (default: `DRY_RUN`) logs the writes instead.
 */
export async function registerCastVoice(
  client: SupabaseClient,
  input: RegisterCastVoiceInput,
  opts: { dryRun?: boolean } = {},
): Promise<RegisterCastVoiceResult> {
  const db = client as Db;
  const fail = (error: string): CastSaveFailure => ({
    ok: false,
    error,
    stage: "none",
  });

  const findVoice = () =>
    db
      .from("voices")
      .select("id, character_id")
      .eq("current_elevenlabs_id", input.elevenLabsId)
      .maybeSingle();

  const { data: existing, error: findErr } = await findVoice();
  if (findErr) return fail(findErr.message);

  let voiceUuid = existing?.id;
  const dryRun = opts.dryRun ?? isDryRun();
  if (!voiceUuid) {
    const row = buildVoiceRow(input);
    if (dryRun) {
      voiceUuid = randomUUID();
      console.log(`[voice-registry] voices insert ${JSON.stringify(row)}`);
    } else {
      const { data: inserted, error: insertErr } = await db
        .from("voices")
        .insert(row)
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
  } else if (!existing?.character_id && !dryRun) {
    // Best effort: the castlist write below is what playback needs.
    const { error } = await db
      .from("voices")
      .update({ character_id: input.characterId })
      .eq("id", voiceUuid)
      .is("character_id", null);
    if (error)
      console.warn(
        `[voice-registry] character_id on voices row ${voiceUuid}: ${error.message}`,
      );
  }

  const castRow = {
    book_id: input.bookId,
    issue_id: input.issueId,
    character: input.characterId,
    character_id: input.characterId,
    voice_id: input.elevenLabsId,
    voice_uuid: voiceUuid,
  };
  if (dryRun) {
    console.log(`[voice-registry] castlist upsert ${JSON.stringify(castRow)}`);
    return { ok: true, voiceUuid };
  }

  const { error: castErr } = await db
    .from("castlist")
    .upsert(castRow, { onConflict: "book_id,issue_id,character" });
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

// ── The Voice Design path of the ingest workflow (#119, #301) ────────────
// The `generate-voice-models` steps in `generation.ts` wrap these two, so a
// script can run them against a fake client and a fake ElevenLabs transport.

/** `fetch` against `https://api.elevenlabs.io<path>`, as `elevenLabsFetch`. */
export type ElevenLabsFetch = (
  path: string,
  init: RequestInit,
) => Promise<Response>;

export interface VoiceDesignOptions {
  /** Skip every DB write and log it instead (the step passes `isDryRun()`). */
  dryRun: boolean;
}

export interface CharactersNeedingVoices {
  needDesign: string[];
  reused: number;
  /** Characters whose design appearance got its castlist `voice_id` back. */
  repaired: string[];
}

/**
 * The issue's speakers that need Voice Design. First, #301 case 1: when this
 * issue's castlist row for a character has `voice_uuid` and the character's
 * design appearance has no `voice_id`, the castlist voice is written back to
 * the appearance, so a later issue without a castlist row takes the
 * stored-id path instead of a second paid create.
 */
export async function findCharactersNeedingVoices(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
  opts: VoiceDesignOptions,
): Promise<CharactersNeedingVoices> {
  const db = client as Db;
  const [
    { data: bubbleRows, error: bubErr },
    { data: aliasRows, error: aliasErr },
    { data: castRows, error: castErr },
  ] = await Promise.all([
    db
      .from("bubbles")
      .select("speaker")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("ignored", false)
      .eq("silent", false)
      .not("speaker", "is", null),
    db
      .from("aliases")
      .select("alias, canonical, scope, scope_id")
      .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`),
    db
      .from("castlist")
      .select("character, character_id, voice_id, voice_uuid")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
  ]);
  if (bubErr) throw new Error(bubErr.message);
  if (aliasErr) throw new Error(aliasErr.message);
  if (castErr) throw new Error(castErr.message);

  const aliasMap = buildAliasMap(aliasRows ?? []);
  const castlist = castRows ?? [];
  const cast = buildCastIndex(castlist);
  const rawSpeakers = (bubbleRows ?? [])
    .map((b) => b.speaker)
    .filter((s): s is string => !!s);
  const castKey = (r: { character: string; character_id: string | null }) =>
    r.character_id ?? slugify(r.character);
  const appearances = await readPlanningAppearances(db, [
    ...speakerKeys(rawSpeakers, aliasMap),
    ...castlist.map(castKey),
  ]);

  const repaired: string[] = [];
  for (const row of castlist) {
    if (!row.voice_uuid || !row.voice_id || row.voice_id === SKIPPED_VOICE)
      continue;
    const key = castKey(row);
    const appearance = appearances.find(
      (a) => a.id === voiceDesignAppearanceId(key),
    );
    if (!appearance || appearance.voice_id?.trim()) continue;
    if (opts.dryRun) {
      console.log(
        `[get-chars] would write voice_id=${row.voice_id} to ${appearance.id}`,
      );
    } else {
      const { error } = await db
        .from("character_appearances")
        .update({ voice_id: row.voice_id })
        .eq("id", appearance.id);
      if (error)
        throw new Error(
          `writing castlist voice ${row.voice_id} back to ${appearance.id}: ${error.message}`,
        );
    }
    appearance.voice_id = row.voice_id;
    repaired.push(key);
  }

  const plan = planCharactersNeedingVoices(
    rawSpeakers,
    aliasMap,
    cast,
    appearances,
  );

  for (const row of plan.reuse) {
    const appearance = appearances.find(
      (a) => a.character_id === row.character && a.voice_id === row.voice_id,
    );
    const saved = await registerCastVoice(
      db,
      {
        bookId,
        issueId,
        characterId: row.character,
        elevenLabsId: row.voice_id,
        designPrompt: appearance?.voice_description?.trim(),
      },
      { dryRun: opts.dryRun },
    );
    if (!saved.ok) throw new Error(castSaveFailureMessage(row.voice_id, saved));
  }

  return { needDesign: plan.needDesign, reused: plan.reuse.length, repaired };
}

export type DesignCharacterOutcome =
  | "registered"
  | "stored id"
  | "has voices row"
  | "no description"
  | "created";

/**
 * One character's Voice Design voice for the ingest workflow. Returns early,
 * with no ElevenLabs call, when the issue's castlist already points at a
 * voice, when the design appearance stores a created id (#119), or when the
 * character has a `voices` row (#351: a new voice for a character who has
 * one is the voices stop's call, through `carryOut`).
 *
 * After a paid create (#301): a failed first `voice_id` write is logged, not
 * thrown, once the ready update stores the id (case 3); a failed ready
 * update retries the `voice_id`-only write before it throws (case 2).
 */
export async function designCharacterVoice(
  client: SupabaseClient,
  input: { bookId: string; issueId: string; characterId: string },
  opts: VoiceDesignOptions & { fetch: ElevenLabsFetch },
): Promise<{ outcome: DesignCharacterOutcome; voiceId?: string }> {
  const db = client as Db;
  const { bookId, issueId, characterId } = input;
  const appearanceId = voiceDesignAppearanceId(characterId);
  const { data: appearance, error: appErr } = await db
    .from("character_appearances")
    .select(
      "id, character_id, voice_id, voice_status, voice_description, voice_created_at",
    )
    .eq("id", appearanceId)
    .maybeSingle();
  if (appErr) throw new Error(appErr.message);

  const markAppearanceReady = async (voiceId: string | null) => {
    if (opts.dryRun) return;
    const { error } = await db
      .from("character_appearances")
      .update({
        voice_id: voiceId,
        voice_type: "voice_design",
        voice_status: "ready",
        voice_created_at:
          appearance?.voice_created_at ?? new Date().toISOString(),
      })
      .eq("id", appearanceId);
    if (!error) return;
    // Keep the one pointer that stops a second paid create (#301 case 2).
    const retry = await db
      .from("character_appearances")
      .update({ voice_id: voiceId })
      .eq("id", appearanceId);
    throw new Error(
      `appearance ready update failed for ${characterId} voice_id=${voiceId}: ${error.message}; ` +
        (retry.error
          ? `the voice_id-only retry failed too: ${retry.error.message}`
          : "the voice_id-only retry stored the id"),
    );
  };

  const register = async (elevenLabsId: string, designPrompt?: string) => {
    const saved = await registerCastVoice(
      db,
      { bookId, issueId, characterId, elevenLabsId, designPrompt },
      { dryRun: opts.dryRun },
    );
    return saved;
  };

  // A retry must not design a second ElevenLabs voice for a character that
  // already has a `voices` row (#119). Looked up by the castlist row's
  // `voice_uuid`, never by display name (row 153).
  const registeredVoice = await findRegisteredVoice(db, input);
  if (registeredVoice) {
    await markAppearanceReady(registeredVoice.current_elevenlabs_id);
    console.log(
      `[voice-model] ${characterId}: already registered, skipping; voices row ${registeredVoice.id}`,
    );
    return { outcome: "registered" };
  }

  if (appearance?.voice_id?.trim()) {
    // A stored id means create already landed, even if registration or
    // marking the appearance ready failed (#119).
    const saved = await register(
      appearance.voice_id,
      appearance.voice_description?.trim(),
    );
    if (!saved.ok)
      throw new Error(castSaveFailureMessage(appearance.voice_id, saved));
    await markAppearanceReady(appearance.voice_id);
    console.log(
      `[voice-model] ${characterId}: already created, registered as voices row ${saved.voiceUuid}`,
    );
    return { outcome: "stored id", voiceId: appearance.voice_id };
  }

  const { data: owned, error: ownedErr } = await db
    .from("voices")
    .select("id, status, current_elevenlabs_id")
    .eq("character_id", characterId)
    .order("created_at", { ascending: false });
  if (ownedErr) throw new Error(ownedErr.message);
  if (owned && owned.length > 0) {
    const active = owned.find(
      (v) => v.status === "active" && v.current_elevenlabs_id,
    );
    if (active?.current_elevenlabs_id) {
      const saved = await register(active.current_elevenlabs_id);
      if (!saved.ok)
        throw new Error(
          castSaveFailureMessage(active.current_elevenlabs_id, saved),
        );
      await markAppearanceReady(active.current_elevenlabs_id);
    }
    console.log(
      `[voice-model] ${characterId}: has voices row ${active?.id ?? owned[0]!.id} (${active ? "active, cast here" : owned[0]!.status}); no Voice Design, the voices stop decides`,
    );
    return {
      outcome: "has voices row",
      voiceId: active?.current_elevenlabs_id ?? undefined,
    };
  }

  const voiceDescription = appearance?.voice_description?.trim();
  if (!voiceDescription) {
    console.log(
      `[voice-model] ${characterId}: no voice description on ${appearanceId}, skipping`,
    );
    return { outcome: "no description" };
  }

  const { recordElevenLabsCall } = await import("~/lib/llm-usage");
  const llmMeta = { step: "generate-voice-models", bookId, issueId };
  const designRes = await recordElevenLabsCall(
    { ...llmMeta, model: "eleven_ttv_v3" },
    null,
    () =>
      opts.fetch("/v1/text-to-voice/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice_description: voiceDescription,
          model_id: "eleven_ttv_v3",
          auto_generate_text: true,
        }),
      }),
  );
  if (!designRes.ok) {
    const err = await designRes.text();
    throw new Error(
      `Voice design failed for ${characterId}: ${designRes.status} ${err.slice(0, 200)}`,
    );
  }
  const designData = (await designRes.json()) as {
    previews: { generated_voice_id: string }[];
  };
  const generatedVoiceId = designData.previews[0]?.generated_voice_id;
  if (!generatedVoiceId)
    throw new Error(`No preview returned for ${characterId}`);

  const createRes = await recordElevenLabsCall(
    { ...llmMeta, model: "text-to-voice" },
    null,
    () =>
      opts.fetch("/v1/text-to-voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice_name: characterId,
          voice_description: voiceDescription,
          generated_voice_id: generatedVoiceId,
        }),
      }),
  );
  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(
      `Voice create failed for ${characterId}: ${createRes.status} ${err.slice(0, 200)}`,
    );
  }

  const { voice_id } = (await createRes.json()) as { voice_id: string };
  console.log(
    `[voice-model] ${characterId}: paid create returned voice_id=${voice_id}`,
  );
  if (!opts.dryRun) {
    // Keep the created id before registration, so a failed castlist save
    // cannot send the next run through Voice Design again. A failure here
    // is not thrown: the ready update below writes the id again (#301 case 3).
    const { error } = await db
      .from("character_appearances")
      .update({ voice_id })
      .eq("id", appearanceId);
    if (error)
      console.warn(
        `[voice-model] ${characterId}: first voice_id write failed, the ready update retries it: ${error.message}`,
      );
  }
  const registered = await register(voice_id, voiceDescription);
  // Retry storing the id even if the first appearance write or registry
  // save failed, so either durable pointer can prevent a second create.
  await markAppearanceReady(voice_id);
  if (!registered.ok)
    throw new Error(castSaveFailureMessage(voice_id, registered));

  console.log(
    `[voice-model] ${characterId}: created voice ${voice_id}, voices row ${registered.voiceUuid}`,
  );
  return { outcome: "created", voiceId: voice_id };
}
