import { FatalError } from "workflow";
import type { Json } from "~/types/database";
import {
  bubbleNeedsAudio,
  collapseAudioJobs,
  normalizeAlignment,
  planBubbleVoices,
  type AlignmentRaw,
  type AudioJob,
} from "./audio-plan";
import { chunk } from "~/lib/chunk";
import { buildTtsRequest, TTS_MODEL } from "~/lib/tts-request";

const fatal = (err: unknown) =>
  new FatalError(err instanceof Error ? err.message : String(err));

/**
 * The audio step's work: the bubbles with no audio that `bubbleNeedsAudio`,
 * as jobs (`collapseAudioJobs`). Members of a joined group (#451) with two or
 * more active members fold into one job for the group.
 */
export async function getAudioJobs(
  bookId: string,
  issueId: string,
): Promise<AudioJob[]> {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  const { data: bubbles, error } = await supabase
    .from("bubbles")
    .select(
      "id, speaker, ignored, silent, audio_storage_path, text_with_cues, ocr_text, page_number, sort_order, group_id",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("ignored", false)
    .eq("silent", false)
    .is("audio_storage_path", null)
    .order("page_number")
    .order("sort_order");

  if (error) throw new FatalError(error.message);

  const selected = (bubbles ?? []).filter((b) => bubbleNeedsAudio(b));

  // Active members per group, counted over the whole group (members that
  // already have audio included), so a group with one member selected still
  // renders as a group.
  const groupIds = [
    ...new Set(selected.flatMap((b) => (b.group_id ? [b.group_id] : []))),
  ];
  const activeGroupSize = new Map<string, number>();
  for (const ids of chunk(groupIds, 100)) {
    const { data: members, error: gErr } = await supabase
      .from("bubbles")
      .select("group_id")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("ignored", false)
      .eq("silent", false)
      .in("group_id", ids);
    if (gErr) throw new FatalError(gErr.message);
    for (const m of members ?? []) {
      if (m.group_id)
        activeGroupSize.set(
          m.group_id,
          (activeGroupSize.get(m.group_id) ?? 0) + 1,
        );
    }
  }

  const jobs = collapseAudioJobs(selected, activeGroupSize);
  const groups = jobs.filter((j) => "groupId" in j).length;
  console.log(
    `[get-bubbles] ${bookId}/${issueId}: ${selected.length} bubbles need audio, ${jobs.length} jobs (${groups} joined groups)`,
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
    } else if (result.skipped === "single") {
      bubbleIds.push(...job.bubbleIds);
    } else {
      const detail =
        "memberId" in result
          ? ` (member ${result.memberId})`
          : "detail" in result
            ? ` (${result.detail})`
            : "";
      console.log(
        `[audio] skip group ${job.groupId}: ${result.skipped}${detail}`,
      );
    }
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
        voice_id: voiceUuid,
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
    `[audio] ${bookId}/${issueId}: generated ${generated}/${jobs.length} audio files`,
  );
}
generateAudioBatch.maxRetries = 0;
