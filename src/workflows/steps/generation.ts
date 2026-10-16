import { FatalError } from "workflow";
import { planBubbleVoices, type AudioJob } from "./audio-plan";
import { buildTtsRequest, TTS_MODEL } from "~/lib/tts-request";

const fatal = (err: unknown) =>
  new FatalError(err instanceof Error ? err.message : String(err));

/**
 * The audio step's work: `loadAudioJobs`, the job selection the casting
 * page's estimate counts too (#106). The bubbles with no audio that
 * `bubbleNeedsAudio`, as jobs; members of a joined group (#451) with two or
 * more active members fold into one job for the group.
 */
export async function getAudioJobs(
  bookId: string,
  issueId: string,
): Promise<AudioJob[]> {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();
  const { loadAudioJobs } = await import("~/lib/audio-estimate");

  const { jobs, selected } = await loadAudioJobs(
    supabase,
    bookId,
    issueId,
  ).catch((e: unknown) => {
    throw fatal(e);
  });
  const groups = jobs.filter((j) => "groupId" in j).length;
  console.log(
    `[get-bubbles] ${bookId}/${issueId}: ${selected} bubbles need audio, ${jobs.length} jobs (${groups} joined groups)`,
  );
  return jobs;
}

export async function generateAudioBatch(
  bookId: string,
  issueId: string,
  jobs: AudioJob[],
) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();
  const { getElevenLabsClient } = await import("~/lib/elevenlabs-client");
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new FatalError("ELEVENLABS_API_KEY not set");

  const client = await getElevenLabsClient();
  const { recordElevenLabsCall } = await import("~/lib/llm-usage");

  const { loadBookCast } = await import("~/lib/cast");
  const book = await loadBookCast(supabase, bookId).catch((e: Error) => {
    throw new FatalError(e.message);
  });

  // Groups first: one render each. A group that turns out to have fewer than
  // two active members falls back to its selected bubbles rendered alone.
  const { renderGroupAudio } = await import("~/lib/render-group-audio");
  const bubbleIds: string[] = [];
  let generated = 0;
  for (const job of jobs) {
    if ("bubbleId" in job) {
      bubbleIds.push(job.bubbleId);
      continue;
    }
    let result;
    try {
      result = await renderGroupAudio({
        client: supabase,
        bookId,
        issueId,
        groupId: job.groupId,
        step: "generate-audio",
        book,
      });
    } catch (e) {
      throw fatal(e);
    }
    if ("rendered" in result) {
      generated++;
      console.log(
        `[audio] group ${job.groupId}: ${result.memberIds.length} balloons, ${result.characters} chars -> ${result.path}`,
      );
      continue;
    }
    let detail: string;
    switch (result.skipped) {
      case "single":
        bubbleIds.push(...job.bubbleIds);
        continue;
      case "no-text":
      case "inactive-member":
        detail = ` (member ${result.memberId})`;
        break;
      case "non-adjacent":
      case "mixed-speakers":
      case "no-voice":
      case "stale-group":
        detail = ` (${result.detail})`;
        break;
      case "unchanged":
        // Only with `skipIfUnchanged`, which the step does not pass.
        detail = ` (already plays ${result.path})`;
        break;
    }
    console.log(
      `[audio] skip group ${job.groupId}: ${result.skipped}${detail}`,
    );
  }

  const { data: fetched, error: bubErr } =
    bubbleIds.length > 0
      ? await supabase
          .from("bubbles")
          .select(
            "id, speaker, character_id, text_with_cues, ocr_text, audio_storage_path, ignored, silent",
          )
          .in("id", bubbleIds)
      : { data: [], error: null };

  if (bubErr) throw new FatalError(bubErr.message);
  const bubbles = fetched ?? [];

  const sendPlan = planBubbleVoices(bubbles, book, issueId);
  for (const { bubble, reason, lookup: found } of sendPlan.skipped) {
    const speaker = bubble.speaker?.trim() ?? "";
    console.log(
      `[audio] skip ${bubble.id} speaker=${speaker === "" ? "(none)" : speaker}: ${reason}${found && !found.ok ? ` (${found.detail})` : ""}`,
    );
  }

  const { loadVoiceOverrides } = await import("~/lib/voice-overrides");
  const overrides = await loadVoiceOverrides(
    supabase,
    sendPlan.toSend.map((s) => s.lookup.elevenLabsId),
  ).catch((err: unknown) => {
    throw fatal(err);
  });

  const { audioHash } = await import("~/lib/tts-hash");
  const { BubbleRenderError, storeBubbleTake } = await import(
    "~/lib/render-bubble-audio"
  );
  for (const {
    bubble,
    lookup: { elevenLabsId: voiceId, voiceUuid },
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

    // The take pattern regenerate uses: a fresh path, then one switch that
    // writes the timings, path, voice and hash together.
    try {
      await storeBubbleTake({
        client: supabase,
        bookId,
        issueId,
        bubbleId: bubble.id,
        voiceUuid,
        hash: audioHash(voiceId, request),
        response,
      });
    } catch (e) {
      const stage = e instanceof BubbleRenderError ? ` at ${e.stage}` : "";
      throw new FatalError(
        `store ${bubble.id}${stage}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    generated++;
  }

  console.log(
    `[audio] ${bookId}/${issueId}: generated ${generated}/${jobs.length} audio files`,
  );
}
generateAudioBatch.maxRetries = 0;
