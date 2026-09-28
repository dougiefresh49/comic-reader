"use server";

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { checkAdminAuth } from "~/lib/admin-auth";
import { supabaseAdmin } from "~/lib/supabase-admin";
import type { AliasRow, CastRow } from "~/workflows/steps/audio-plan";
import { resolveSpeakerVoice } from "./resolve-castlist-row";

const AUDIO_BUCKET = "comic-audio";

interface Args {
  bookId: string;
  issueId: string;
  bubbleId: string;
}

interface AlignmentRaw {
  characters?: string[];
  character_start_times_seconds?: number[];
  character_end_times_seconds?: number[];
  characterStartTimesSeconds?: number[];
  characterEndTimesSeconds?: number[];
}

function normalizeAlignment(raw: AlignmentRaw | null | undefined) {
  if (!raw) return null;
  return {
    characters: raw.characters ?? [],
    character_start_times_seconds:
      raw.character_start_times_seconds ?? raw.characterStartTimesSeconds ?? [],
    character_end_times_seconds:
      raw.character_end_times_seconds ?? raw.characterEndTimesSeconds ?? [],
  };
}

type Step = "generate" | "upload" | "timings" | "bubble" | "refresh";

const PIPELINE_AGAIN =
  " The next pipeline audio run will generate this bubble again and spend credits.";

/**
 * The error for a failure at or after the paid ElevenLabs call: what the
 * reader plays now, and that a retry spends credits again. The reader of
 * this text is the owner in the review editor. With no stored path the
 * reader plays `${bubble.id}.mp3`, which is where the upload goes.
 * `restoreError` is set when a failed upload could not put the old
 * timings row back.
 */
function afterSpendError(
  step: Step,
  bubbleId: string,
  hadAudio: boolean,
  message: string,
  restoreError: string | null = null,
) {
  const saved =
    step === "generate"
      ? `Generating audio for bubble ${bubbleId} failed (${message}), and ElevenLabs may have charged for it.`
      : step === "upload"
        ? restoreError === null
          ? `Audio for bubble ${bubbleId} was generated and paid for, but the Storage upload failed (${message}), so nothing was saved.`
          : `Audio for bubble ${bubbleId} was generated and paid for, but the Storage upload failed (${message}) and the old word timings could not be put back (${restoreError}), so ${hadAudio ? "the old audio now plays with the new word timings and highlighting will be wrong until a regenerate succeeds." : "a timings row was saved with no audio behind it."}`
        : step === "timings"
          ? `Audio for bubble ${bubbleId} was generated and paid for, but its word timings did not save to audio_timestamps (${message}), so nothing was saved${hadAudio ? " and the reader still plays the old audio with its own timings." : `.${PIPELINE_AGAIN}`}`
          : step === "bubble"
            ? `The new audio and word timings for bubble ${bubbleId} are saved, but the bubbles row was not updated (${message}).${hadAudio ? "" : PIPELINE_AGAIN}`
            : `The new audio and word timings for bubble ${bubbleId} are saved, and only the page refresh failed (${message}), so reload the page to hear it.`;
  return {
    ok: false as const,
    error: `${saved} Regenerating will spend ElevenLabs credits again.`,
  };
}

export async function regenerateAudio(args: Args) {
  const auth = checkAdminAuth((await headers()).get("authorization"));
  if (!auth.ok) return { ok: false, error: auth.message };
  if (!process.env.ELEVENLABS_API_KEY) {
    return { ok: false, error: "ELEVENLABS_API_KEY not configured" };
  }

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      args.bubbleId,
    );
  const bubbleQ = supabaseAdmin
    .from("bubbles")
    .select(
      "id, legacy_id, speaker, ocr_text, text_with_cues, type, ignored, audio_storage_path, book_id, issue_id",
    )
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId);
  const { data: bubble, error: bErr } = await (isUuid
    ? bubbleQ.eq("id", args.bubbleId).maybeSingle()
    : bubbleQ.eq("legacy_id", args.bubbleId).maybeSingle());

  if (bErr || !bubble) {
    return { ok: false, error: bErr?.message ?? "Bubble not found" };
  }
  type BubbleRow = {
    id: string;
    legacy_id: string | null;
    speaker: string | null;
    ocr_text: string | null;
    text_with_cues: string | null;
    type: string;
    ignored: boolean | null;
    audio_storage_path: string | null;
  };
  const b = bubble as BubbleRow;

  if (b.ignored) {
    return { ok: false, error: "Bubble is ignored — cannot regenerate audio" };
  }
  if (!b.speaker) {
    return { ok: false, error: "No speaker assigned" };
  }
  const text = b.text_with_cues ?? b.ocr_text ?? "";
  if (!text.trim()) {
    return { ok: false, error: "Empty text" };
  }

  // Look up voice ID with the audio step's rule: exact match, else alias then slug
  const [
    { data: castRows, error: castErr },
    { data: aliasRows, error: aliasErr },
  ] = await Promise.all([
    supabaseAdmin
      .from("castlist")
      .select("character, voice_id")
      .eq("book_id", args.bookId)
      .eq("issue_id", args.issueId),
    supabaseAdmin
      .from("aliases")
      .select("alias, canonical")
      .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${args.bookId})`),
  ]);
  if (castErr) {
    return { ok: false, error: castErr.message };
  }
  if (aliasErr) {
    return { ok: false, error: aliasErr.message };
  }
  const resolved = resolveSpeakerVoice(
    b.speaker,
    (castRows ?? []) as CastRow[],
    (aliasRows ?? []) as AliasRow[],
  );
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  const voiceId = resolved.voiceId;
  if (!voiceId) {
    return {
      ok: false,
      error: `No voice ID for speaker '${b.speaker}' in castlist`,
    };
  }

  // The timings row is written before the upload, so a failed timings write
  // leaves the old take whole. If the upload then fails, the old row goes
  // back, which is why it is read here, before any credits are spent.
  const { data: oldTs, error: oldTsErr } = await supabaseAdmin
    .from("audio_timestamps")
    .select("alignment, normalized_alignment")
    .eq("bubble_id", b.id)
    .maybeSingle();
  if (oldTsErr) {
    return { ok: false, error: oldTsErr.message };
  }
  const oldTimings = oldTs as {
    alignment: unknown;
    normalized_alignment: unknown;
  } | null;
  /** Puts the old timings row back; returns the error text if that fails. */
  async function restoreTimings(): Promise<string | null> {
    try {
      const { error } = oldTimings
        ? await supabaseAdmin.from("audio_timestamps").upsert(
            {
              bubble_id: b.id,
              book_id: args.bookId,
              issue_id: args.issueId,
              ...oldTimings,
            },
            { onConflict: "bubble_id" },
          )
        : await supabaseAdmin
            .from("audio_timestamps")
            .delete()
            .eq("bubble_id", b.id);
      return error?.message ?? null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  const hadAudio = b.audio_storage_path != null;
  let step: Step = "generate";
  try {
    const client = new ElevenLabsClient({
      apiKey: process.env.ELEVENLABS_API_KEY,
    });
    const response = await client.textToSpeech.convertWithTimestamps(voiceId, {
      modelId: "eleven_v3",
      text,
    });
    const audioBuffer = Buffer.from(response.audioBase64, "base64");

    const storagePath = b.audio_storage_path ?? `${b.id}.mp3`;
    const remotePath = `${args.bookId}/${args.issueId}/${storagePath}`;

    const alignment = normalizeAlignment(
      response.alignment as AlignmentRaw | null | undefined,
    );
    const normalizedAlignment = normalizeAlignment(
      response.normalizedAlignment as AlignmentRaw | null | undefined,
    );

    step = "timings";
    const { error: tsErr } = await supabaseAdmin
      .from("audio_timestamps")
      .upsert(
        {
          bubble_id: b.id,
          book_id: args.bookId,
          issue_id: args.issueId,
          alignment,
          normalized_alignment: normalizedAlignment,
        },
        { onConflict: "bubble_id" },
      );
    if (tsErr) {
      return afterSpendError(step, b.id, hadAudio, tsErr.message);
    }

    step = "upload";
    const { error: upErr } = await supabaseAdmin.storage
      .from(AUDIO_BUCKET)
      .upload(remotePath, audioBuffer, {
        contentType: "audio/mpeg",
        upsert: true,
      });
    if (upErr) {
      return afterSpendError(
        step,
        b.id,
        hadAudio,
        upErr.message,
        await restoreTimings(),
      );
    }

    // From here the reader loads the new take and its timings: the stored
    // path is unchanged, or it is null and the reader falls back to
    // `${b.id}.mp3`, where the upload went.
    step = "bubble";
    const { error: bubbleErr } = await supabaseAdmin
      .from("bubbles")
      .update({
        needs_audio: false,
        audio_storage_path: storagePath,
        updated_at: new Date().toISOString(),
      })
      .eq("id", b.id);
    if (bubbleErr) {
      return afterSpendError(step, b.id, hadAudio, bubbleErr.message);
    }

    step = "refresh";
    revalidatePath(`/book/${args.bookId}/${args.issueId}`, "page");
    revalidatePath(`/book/${args.bookId}/${args.issueId}/review`, "page");

    return {
      ok: true,
      audioStoragePath: storagePath,
    };
  } catch (e) {
    const restoreError = step === "upload" ? await restoreTimings() : null;
    return afterSpendError(
      step,
      b.id,
      hadAudio,
      (e as Error).message,
      restoreError,
    );
  }
}
