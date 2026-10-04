import { FatalError } from "workflow";
import type { Json } from "~/types/database";
import {
  bubbleNeedsAudio,
  formatCastConflicts,
  normalizeAlignment,
  planBubbleVoices,
  type AlignmentRaw,
  voiceLookupContext,
} from "./audio-plan";
import { buildTtsRequest, TTS_MODEL } from "~/lib/tts-request";
import { isDryRun } from "~/lib/fakes/dry-run";
import {
  designCharacterVoice,
  findCharactersNeedingVoices,
} from "~/lib/voices-registry";

const fatal = (err: unknown) =>
  new FatalError(err instanceof Error ? err.message : String(err));

export async function getCharactersNeedingVoices(
  bookId: string,
  issueId: string,
): Promise<string[]> {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();
  const found = await findCharactersNeedingVoices(supabase, bookId, issueId, {
    dryRun: isDryRun(),
  }).catch((err: unknown) => {
    throw fatal(err);
  });
  console.log(
    `[get-chars] ${bookId}/${issueId}: ${found.needDesign.length} need Voice Design, ${found.reused} castlist reuse from ready appearances` +
      (found.repaired.length > 0
        ? `, castlist voice written back to ${found.repaired.join(", ")}`
        : ""),
  );
  return found.needDesign;
}

export async function generateVoiceModel(
  bookId: string,
  issueId: string,
  characterId: string,
) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();
  if (!process.env.ELEVENLABS_API_KEY)
    throw new FatalError("ELEVENLABS_API_KEY not set");
  const { elevenLabsFetch } = await import("~/lib/elevenlabs-client");
  await designCharacterVoice(
    supabase,
    { bookId, issueId, characterId },
    { dryRun: isDryRun(), fetch: elevenLabsFetch },
  ).catch((err: unknown) => {
    throw fatal(err);
  });
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
      "id, speaker, character_id, text_with_cues, ocr_text, audio_storage_path, ignored, silent",
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

  const { loadVoiceOverrides } = await import("~/lib/voice-overrides");
  const overrides = await loadVoiceOverrides(
    supabase,
    sendPlan.toSend.map((s) => s.lookup.voiceId),
  ).catch((err: unknown) => {
    throw fatal(err);
  });

  let generated = 0;

  for (const {
    bubble,
    lookup: { voiceId },
  } of sendPlan.toSend) {
    const request = buildTtsRequest({
      text: (bubble.text_with_cues ?? bubble.ocr_text)!,
      voiceId,
      override: overrides.get(voiceId),
    });

    let response;
    try {
      response = await recordElevenLabsCall(
        { step: "generate-audio", bookId, issueId, model: TTS_MODEL },
        request.text.length,
        () => client.textToSpeech.convertWithTimestamps(voiceId, request),
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
