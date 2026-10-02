import { FatalError } from "workflow";
import type { Json } from "~/types/database";
import {
  buildAliasMap,
  buildCastIndex,
  bubbleNeedsAudio,
  formatCastConflicts,
  normalizeAlignment,
  planBubbleVoices,
  planCharactersNeedingVoices,
  readPlanningAppearances,
  speakerKeys,
  type AlignmentRaw,
  voiceDesignAppearanceId,
  voiceLookupContext,
} from "./audio-plan";
import { buildTtsRequest, TTS_MODEL } from "~/lib/tts-request";
import { isDryRun } from "~/lib/fakes/dry-run";
import {
  castSaveFailureMessage,
  findRegisteredVoice,
  registerCastVoice,
} from "~/lib/voices-registry";

export async function getCharactersNeedingVoices(
  bookId: string,
  issueId: string,
): Promise<string[]> {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  const [
    { data: bubbleRows, error: bubErr },
    { data: aliasRows, error: aliasErr },
    { data: castRows, error: castErr },
  ] = await Promise.all([
    supabase
      .from("bubbles")
      .select("speaker")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("ignored", false)
      .eq("silent", false)
      .not("speaker", "is", null),
    supabase
      .from("aliases")
      .select("alias, canonical, scope, scope_id")
      .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`),
    supabase
      .from("castlist")
      .select("character, voice_id")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
  ]);

  if (bubErr) throw new FatalError(bubErr.message);
  if (aliasErr) throw new FatalError(aliasErr.message);
  if (castErr) throw new FatalError(castErr.message);

  const aliasMap = buildAliasMap(aliasRows ?? []);
  const cast = buildCastIndex(castRows ?? []);
  const rawSpeakers = (bubbleRows ?? [])
    .map((b) => b.speaker)
    .filter((s): s is string => !!s);
  const appearances = await readPlanningAppearances(
    supabase,
    speakerKeys(rawSpeakers, aliasMap),
  ).catch((err: unknown) => {
    throw new FatalError(err instanceof Error ? err.message : String(err));
  });

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
    const saved = await registerCastVoice(supabase, {
      bookId,
      issueId,
      characterId: row.character,
      elevenLabsId: row.voice_id,
      designPrompt: appearance?.voice_description?.trim(),
    });
    if (!saved.ok) {
      throw new FatalError(castSaveFailureMessage(row.voice_id, saved));
    }
  }

  console.log(
    `[get-chars] ${bookId}/${issueId}: ${plan.needDesign.length} need Voice Design, ${plan.reuse.length} castlist reuse from ready appearances`,
  );
  return plan.needDesign;
}

export async function generateVoiceModel(
  bookId: string,
  issueId: string,
  characterId: string,
) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new FatalError("ELEVENLABS_API_KEY not set");

  const appearanceId = voiceDesignAppearanceId(characterId);
  const { data: appearance, error: appErr } = await supabase
    .from("character_appearances")
    .select(
      "id, character_id, voice_id, voice_status, voice_description, voice_created_at",
    )
    .eq("id", appearanceId)
    .maybeSingle();

  if (appErr) throw new FatalError(appErr.message);

  const markAppearanceReady = async (voiceId: string | null) => {
    if (isDryRun()) return;
    const { error } = await supabase
      .from("character_appearances")
      .update({
        voice_id: voiceId,
        voice_type: "voice_design",
        voice_status: "ready",
        voice_created_at:
          appearance?.voice_created_at ?? new Date().toISOString(),
      })
      .eq("id", appearanceId);
    if (error) {
      throw new FatalError(
        `appearance ready update failed for ${characterId} voice_id=${voiceId}: ${error.message}`,
      );
    }
  };

  // A retry must not design a second ElevenLabs voice for a character that
  // already has a `voices` row (#119). Looked up by the castlist row's
  // `voice_uuid`, never by display name (row 153).
  const registeredVoice = await findRegisteredVoice(supabase, {
    bookId,
    issueId,
    characterId,
  }).catch((err: unknown) => {
    throw new FatalError(err instanceof Error ? err.message : String(err));
  });
  if (registeredVoice) {
    await markAppearanceReady(registeredVoice.current_elevenlabs_id);
    console.log(
      `[voice-model] ${characterId}: already registered, skipping; voices row ${registeredVoice.id}`,
    );
    return;
  }

  if (appearance?.voice_id?.trim()) {
    // A stored id means create already landed, even if registration or
    // marking the appearance ready failed (#119).
    const saved = await registerCastVoice(supabase, {
      bookId,
      issueId,
      characterId,
      elevenLabsId: appearance.voice_id,
      designPrompt: appearance.voice_description?.trim(),
    });
    if (!saved.ok) {
      throw new FatalError(castSaveFailureMessage(appearance.voice_id, saved));
    }
    await markAppearanceReady(appearance.voice_id);
    console.log(
      `[voice-model] ${characterId}: already created, registered as voices row ${saved.voiceUuid}`,
    );
    return;
  }

  const voiceDescription = appearance?.voice_description?.trim();
  if (!voiceDescription) {
    console.log(
      `[voice-model] ${characterId}: no voice description on ${appearanceId}, skipping`,
    );
    return;
  }

  const { elevenLabsFetch } = await import("~/lib/elevenlabs-client");
  const { recordElevenLabsCall } = await import("~/lib/llm-usage");
  const llmMeta = { step: "generate-voice-models", bookId, issueId };
  const designRes = await recordElevenLabsCall(
    { ...llmMeta, model: "eleven_ttv_v3" },
    null,
    () =>
      elevenLabsFetch("/v1/text-to-voice/design", {
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
    throw new FatalError(
      `Voice design failed for ${characterId}: ${designRes.status} ${err.slice(0, 200)}`,
    );
  }

  const designData = (await designRes.json()) as {
    previews: { generated_voice_id: string }[];
  };
  const generatedVoiceId = designData.previews[0]?.generated_voice_id;
  if (!generatedVoiceId) {
    throw new FatalError(`No preview returned for ${characterId}`);
  }

  const createRes = await recordElevenLabsCall(
    { ...llmMeta, model: "text-to-voice" },
    null,
    () =>
      elevenLabsFetch("/v1/text-to-voice", {
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
    throw new FatalError(
      `Voice create failed for ${characterId}: ${createRes.status} ${err.slice(0, 200)}`,
    );
  }

  const { voice_id } = (await createRes.json()) as { voice_id: string };
  let appearanceWriteError: string | null = null;
  if (!isDryRun()) {
    // Keep the created id before registration, so a failed castlist save
    // cannot send the next run through Voice Design again.
    const { error } = await supabase
      .from("character_appearances")
      .update({ voice_id })
      .eq("id", appearanceId);
    if (error) {
      appearanceWriteError = error.message;
    }
  }
  console.log(
    `[voice-model] ${characterId}: paid create returned voice_id=${voice_id}`,
  );
  const registered = await registerCastVoice(supabase, {
    bookId,
    issueId,
    characterId,
    elevenLabsId: voice_id,
    designPrompt: voiceDescription,
  });
  // Retry storing the id even if the first appearance write or registry
  // save failed, so either durable pointer can prevent a second create.
  await markAppearanceReady(voice_id);
  if (!registered.ok) {
    throw new FatalError(castSaveFailureMessage(voice_id, registered));
  }

  if (appearanceWriteError) {
    throw new FatalError(
      `appearance voice id update failed for ${characterId} voice_id=${voice_id}: ${appearanceWriteError}`,
    );
  }

  console.log(
    `[voice-model] ${characterId}: created voice ${voice_id}, voices row ${registered.voiceUuid}`,
  );
}
generateVoiceModel.maxRetries = 0;

export async function getBubbleIdsForAudio(
  bookId: string,
  issueId: string,
): Promise<string[]> {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  const { data: bubbles, error } = await supabase
    .from("bubbles")
    .select(
      "id, speaker, ignored, silent, audio_storage_path, text_with_cues, ocr_text, page_number, sort_order",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("ignored", false)
    .eq("silent", false)
    .is("audio_storage_path", null)
    .order("page_number")
    .order("sort_order");

  if (error) throw new FatalError(error.message);

  const ids = (bubbles ?? [])
    .filter((b) => bubbleNeedsAudio(b))
    .map((b) => b.id);

  console.log(
    `[get-bubbles] ${bookId}/${issueId}: ${ids.length} bubbles need audio`,
  );
  return ids;
}

export async function generateAudioBatch(
  bookId: string,
  issueId: string,
  bubbleIds: string[],
) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();
  const { getElevenLabsClient } = await import("~/lib/elevenlabs-client");
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new FatalError("ELEVENLABS_API_KEY not set");

  const client = await getElevenLabsClient();
  const { recordElevenLabsCall } = await import("~/lib/llm-usage");

  const { data: bubbles, error: bubErr } = await supabase
    .from("bubbles")
    .select(
      "id, speaker, character_id, emotion, text_with_cues, ocr_text, audio_storage_path, ignored, silent",
    )
    .in("id", bubbleIds);

  if (bubErr) throw new FatalError(bubErr.message);
  if (!bubbles || bubbles.length === 0) return;

  const { loadBookCast } = await import("~/lib/cast");
  const [book, { data: aliasRows, error: aliasErr }] = await Promise.all([
    loadBookCast(supabase, bookId).catch((e: Error) => {
      throw new FatalError(e.message);
    }),
    supabase
      .from("aliases")
      .select("alias, canonical, scope, scope_id")
      .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`),
  ]);
  if (aliasErr) throw new FatalError(aliasErr.message);

  const lookup = voiceLookupContext(book, issueId, aliasRows ?? []);
  if (lookup.cast.conflicts.length > 0) {
    throw new FatalError(
      `castlist slug conflicts before audio: ${formatCastConflicts(lookup.cast.conflicts)}`,
    );
  }

  const sendPlan = planBubbleVoices(bubbles, lookup);
  const conflicts = sendPlan.skipped.flatMap((s) =>
    s.lookup && !s.lookup.ok && s.reason === "castlist conflict"
      ? [`${s.bubble.id}: ${s.lookup.detail}`]
      : [],
  );
  if (conflicts.length > 0) {
    throw new FatalError(
      `castlist conflicts before audio: ${conflicts.join("; ")}`,
    );
  }
  for (const { bubble, reason, lookup: found } of sendPlan.skipped) {
    const speaker = bubble.speaker?.trim() ?? "";
    console.log(
      `[audio] skip ${bubble.id} speaker=${speaker === "" ? "(none)" : speaker}: ${reason}${found && !found.ok ? ` (${found.detail})` : ""}`,
    );
  }

  let generated = 0;

  for (const {
    bubble,
    lookup: { voiceId },
  } of sendPlan.toSend) {
    const ttsText = (bubble.text_with_cues ?? bubble.ocr_text)!;

    let response;
    try {
      response = await recordElevenLabsCall(
        { step: "generate-audio", bookId, issueId, model: TTS_MODEL },
        ttsText.length,
        () =>
          client.textToSpeech.convertWithTimestamps(
            voiceId,
            buildTtsRequest({
              text: ttsText,
              emotion: bubble.emotion,
              voiceId,
            }),
          ),
      );
    } catch (e) {
      throw new FatalError(
        e instanceof Error ? e.message : `ElevenLabs error for ${bubble.id}`,
      );
    }

    const audioBuffer = Buffer.from(response.audioBase64, "base64");
    const storagePath = `${bubble.id}.mp3`;
    const remotePath = `${bookId}/${issueId}/${storagePath}`;

    const { error: upErr } = await supabase.storage
      .from("comic-audio")
      .upload(remotePath, audioBuffer, {
        contentType: "audio/mpeg",
        upsert: true,
      });
    if (upErr) throw new FatalError(`upload ${bubble.id}: ${upErr.message}`);

    const alignment = normalizeAlignment(
      response.alignment as AlignmentRaw | null | undefined,
    );
    const normalizedAlignment = normalizeAlignment(
      response.normalizedAlignment as AlignmentRaw | null | undefined,
    );

    const { error: tsErr } = await supabase.from("audio_timestamps").upsert(
      {
        bubble_id: bubble.id,
        book_id: bookId,
        issue_id: issueId,
        alignment: alignment as Json | null,
        normalized_alignment: normalizedAlignment as Json | null,
      },
      { onConflict: "bubble_id" },
    );
    if (tsErr)
      throw new FatalError(`timestamps ${bubble.id}: ${tsErr.message}`);

    const { error: bubUpErr } = await supabase
      .from("bubbles")
      .update({
        audio_storage_path: storagePath,
        needs_audio: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", bubble.id);
    if (bubUpErr) {
      throw new FatalError(`bubble update ${bubble.id}: ${bubUpErr.message}`);
    }

    generated++;
  }

  console.log(
    `[audio] ${bookId}/${issueId}: generated ${generated}/${bubbleIds.length} audio files`,
  );
}
generateAudioBatch.maxRetries = 0;
