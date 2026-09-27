import { FatalError } from "workflow";
import type { Json } from "~/types/database";
import {
  buildAliasMap,
  buildCastVoiceMap,
  bubbleNeedsAudio,
  normalizeAlignment,
  planCharactersNeedingVoices,
  speakerKey,
  type AlignmentRaw,
  type AppearanceRow,
  voiceDesignAppearanceId,
} from "./audio-plan";

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
    { data: appearanceRows, error: appErr },
  ] = await Promise.all([
    supabase
      .from("bubbles")
      .select("speaker")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
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
    supabase
      .from("character_appearances")
      .select(
        "id, character_id, voice_id, voice_status, voice_description, voice_created_at",
      ),
  ]);

  if (bubErr) throw new FatalError(bubErr.message);
  if (aliasErr) throw new FatalError(aliasErr.message);
  if (castErr) throw new FatalError(castErr.message);
  if (appErr) throw new FatalError(appErr.message);

  const aliasMap = buildAliasMap(aliasRows ?? []);
  const castVoiceMap = buildCastVoiceMap(castRows ?? []);
  const appearances = (appearanceRows ?? []) as AppearanceRow[];
  const rawSpeakers = (bubbleRows ?? [])
    .map((b) => b.speaker)
    .filter((s): s is string => !!s);

  const plan = planCharactersNeedingVoices(
    rawSpeakers,
    aliasMap,
    castVoiceMap,
    appearances,
  );

  for (const row of plan.reuse) {
    const { error } = await supabase.from("castlist").upsert(
      {
        book_id: bookId,
        issue_id: issueId,
        character: row.character,
        voice_id: row.voice_id,
      },
      { onConflict: "book_id,issue_id,character" },
    );
    if (error) throw new FatalError(error.message);
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

  if (appearance?.voice_status === "ready" && appearance.voice_id?.trim()) {
    const { error } = await supabase.from("castlist").upsert(
      {
        book_id: bookId,
        issue_id: issueId,
        character: characterId,
        voice_id: appearance.voice_id,
      },
      { onConflict: "book_id,issue_id,character" },
    );
    if (error) throw new FatalError(error.message);
    console.log(
      `[voice-model] ${characterId}: already ready, castlist upserted`,
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

  const designRes = await globalThis.fetch(
    "https://api.elevenlabs.io/v1/text-to-voice/design",
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        voice_description: voiceDescription,
        model_id: "eleven_ttv_v3",
        auto_generate_text: true,
      }),
    },
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

  const createRes = await globalThis.fetch(
    "https://api.elevenlabs.io/v1/text-to-voice",
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        voice_name: characterId,
        voice_description: voiceDescription,
        generated_voice_id: generatedVoiceId,
      }),
    },
  );

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new FatalError(
      `Voice create failed for ${characterId}: ${createRes.status} ${err.slice(0, 200)}`,
    );
  }

  const { voice_id } = (await createRes.json()) as { voice_id: string };
  const voiceCreatedAt = new Date().toISOString();

  const { error: upAppErr } = await supabase
    .from("character_appearances")
    .update({
      voice_id,
      voice_type: "voice_design",
      voice_status: "ready",
      voice_created_at: voiceCreatedAt,
    })
    .eq("id", appearanceId);

  if (upAppErr) throw new FatalError(upAppErr.message);

  const { error: castErr } = await supabase.from("castlist").upsert(
    {
      book_id: bookId,
      issue_id: issueId,
      character: characterId,
      voice_id,
    },
    { onConflict: "book_id,issue_id,character" },
  );
  if (castErr) throw new FatalError(castErr.message);

  console.log(`[voice-model] ${characterId}: created voice ${voice_id}`);
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
      "id, speaker, ignored, audio_storage_path, text_with_cues, ocr_text, page_number, sort_order",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("ignored", false)
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
  const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new FatalError("ELEVENLABS_API_KEY not set");

  const client = new ElevenLabsClient({ apiKey, maxRetries: 0 });

  const { data: bubbles, error: bubErr } = await supabase
    .from("bubbles")
    .select(
      "id, speaker, emotion, text_with_cues, ocr_text, audio_storage_path, ignored",
    )
    .in("id", bubbleIds);

  if (bubErr) throw new FatalError(bubErr.message);
  if (!bubbles || bubbles.length === 0) return;

  const [
    { data: castRows, error: castErr },
    { data: aliasRows, error: aliasErr },
  ] = await Promise.all([
    supabase
      .from("castlist")
      .select("character, voice_id")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    supabase
      .from("aliases")
      .select("alias, canonical, scope, scope_id")
      .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`),
  ]);

  if (castErr) throw new FatalError(castErr.message);
  if (aliasErr) throw new FatalError(aliasErr.message);

  const aliasMap = buildAliasMap(aliasRows ?? []);
  const castMap = buildCastVoiceMap(castRows ?? []);

  const { getVoiceSettingsFromEmotion, SKIPPED_VOICE } = await import(
    "~/lib/voice-settings"
  );

  let generated = 0;
  const unmatchedSpeakers: string[] = [];

  for (const bubble of bubbles) {
    if (bubble.audio_storage_path) continue;
    if (bubble.ignored) continue;

    const ttsText = bubble.text_with_cues ?? bubble.ocr_text;
    if (!ttsText?.trim()) continue;

    const rawSpeaker = bubble.speaker?.trim() ?? "";
    if (!rawSpeaker) {
      unmatchedSpeakers.push("(null)");
      console.log(`[audio] skip ${bubble.id}: no speaker`);
      continue;
    }

    const key = speakerKey(rawSpeaker, aliasMap);
    const voiceId = castMap.get(key);
    if (!voiceId) {
      unmatchedSpeakers.push(rawSpeaker);
      console.log(
        `[audio] skip ${bubble.id}: unmatched speaker "${rawSpeaker}" (key=${key})`,
      );
      continue;
    }
    if (voiceId === SKIPPED_VOICE) continue;

    const settings = getVoiceSettingsFromEmotion(bubble.emotion ?? "neutral");

    let response;
    try {
      response = await client.textToSpeech.convertWithTimestamps(voiceId, {
        modelId: "eleven_v3",
        text: ttsText,
        voiceSettings: {
          stability: settings.stability,
          similarityBoost: settings.similarityBoost,
          style: settings.style,
        },
      });
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

  if (unmatchedSpeakers.length > 0) {
    console.log(
      `[audio] unmatched speakers (skipped): ${[...new Set(unmatchedSpeakers)].join(", ")}`,
    );
  }

  console.log(
    `[audio] ${bookId}/${issueId}: generated ${generated}/${bubbleIds.length} audio files`,
  );
}
generateAudioBatch.maxRetries = 0;
