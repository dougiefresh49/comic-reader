import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBookCast, readCastRow, setIssueVoice } from "~/lib/cast";
import type { Database } from "~/types/database";
import {
  planCharactersNeedingVoices,
  readPlanningAppearances,
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
  // display_name is the character id, as in the backfilled rows.
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
 * The `voices` row this character's castlist row in the issue already
 * points at, or null. Looks the row up by its id, never by `display_name`
 * (row 153: an import candidate row can carry a live voice's name). The
 * castlist row is found by `character_id`.
 */
export async function findRegisteredVoice(
  client: SupabaseClient,
  input: Pick<RegisterCastVoiceInput, "bookId" | "issueId" | "characterId">,
): Promise<{
  id: string;
  current_elevenlabs_id: string | null;
} | null> {
  const db = client as Db;
  const cast = await readCastRow(
    client,
    input.bookId,
    input.issueId,
    input.characterId,
  );
  const voiceUuid = cast?.voice_uuid;
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
 * that owns this ElevenLabs id, or creates one, then points the issue's
 * castlist row at it through `setIssueVoice` (keyed on `character_id`). A
 * found `voices` row gets `character_id` only when it has none. Takes the
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

  if (dryRun) {
    console.log(
      `[voice-registry] castlist ${input.bookId}/${input.issueId}/${input.characterId} voice_uuid=${voiceUuid}`,
    );
    return { ok: true, voiceUuid };
  }

  try {
    await setIssueVoice(
      client,
      input.bookId,
      input.issueId,
      input.characterId,
      voiceUuid,
    );
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      stage: "voices",
      voiceUuid,
    };
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
  /** Characters whose design appearance got its castlist voice's ElevenLabs id back. */
  repaired: string[];
}

/**
 * The issue's speakers (`bubbles.character_id`) that need Voice Design.
 * First, #301 case 1: when this issue's castlist row for a character points
 * at an active voice and the character's design appearance has no
 * `voice_id`, that voice's ElevenLabs id is written back to the appearance,
 * so a later issue without a castlist row takes the stored-id path instead
 * of a second paid create.
 */
export async function findCharactersNeedingVoices(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
  opts: VoiceDesignOptions,
): Promise<CharactersNeedingVoices> {
  const db = client as Db;
  const [{ data: bubbleRows, error: bubErr }, book] = await Promise.all([
    db
      .from("bubbles")
      .select("character_id")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("ignored", false)
      .eq("silent", false)
      .not("character_id", "is", null),
    loadBookCast(client, bookId),
  ]);
  if (bubErr) throw new Error(bubErr.message);

  const castRows = book.rows.flatMap((r) =>
    r.issue_id === issueId && r.character_id
      ? [{ ...r, character_id: r.character_id }]
      : [],
  );
  const speakers = (bubbleRows ?? []).flatMap((b) =>
    b.character_id ? [b.character_id] : [],
  );
  const appearances = await readPlanningAppearances(db, [
    ...speakers,
    ...castRows.map((r) => r.character_id),
  ]);

  const repaired: string[] = [];
  for (const row of castRows) {
    if (!row.voice_uuid || row.no_audio) continue;
    const voice = book.voices.get(row.voice_uuid);
    const elevenLabsId =
      voice?.status === "active" ? voice.current_elevenlabs_id : null;
    if (!elevenLabsId) continue;
    const key = row.character_id;
    const appearance = appearances.find(
      (a) => a.id === voiceDesignAppearanceId(key),
    );
    if (!appearance || appearance.voice_id?.trim()) continue;
    if (opts.dryRun) {
      console.log(
        `[get-chars] would write voice_id=${elevenLabsId} to ${appearance.id}`,
      );
    } else {
      const { error } = await db
        .from("character_appearances")
        .update({ voice_id: elevenLabsId })
        .eq("id", appearance.id);
      if (error)
        throw new Error(
          `writing castlist voice ${elevenLabsId} back to ${appearance.id}: ${error.message}`,
        );
    }
    appearance.voice_id = elevenLabsId;
    repaired.push(key);
  }

  const plan = planCharactersNeedingVoices(
    speakers,
    new Set(castRows.map((r) => r.character_id)),
    appearances,
  );

  for (const row of plan.reuse) {
    const appearance = appearances.find(
      (a) =>
        a.character_id === row.characterId && a.voice_id === row.elevenLabsId,
    );
    const saved = await registerCastVoice(
      db,
      {
        bookId,
        issueId,
        characterId: row.characterId,
        elevenLabsId: row.elevenLabsId,
        designPrompt: appearance?.voice_description?.trim(),
      },
      { dryRun: opts.dryRun },
    );
    if (!saved.ok)
      throw new Error(castSaveFailureMessage(row.elevenLabsId, saved));
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
