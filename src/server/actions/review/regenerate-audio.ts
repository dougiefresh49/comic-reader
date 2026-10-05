"use server";

import { randomUUID } from "node:crypto";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { checkAdminAuth } from "~/lib/admin-auth";
import { recordElevenLabsCall } from "~/lib/llm-usage";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { buildTtsRequest, TTS_MODEL } from "~/lib/tts-request";
import { loadBookCast } from "~/lib/cast";
import { loadVoiceOverrides } from "~/lib/voice-overrides";
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

type Step = "generate" | "upload" | "switch" | "unconfirmed" | "refresh";

const PIPELINE_AGAIN =
  " The next pipeline audio run will generate this bubble again and spend credits.";

/**
 * The error for a failure at or after the paid ElevenLabs call: what the
 * reader plays now, and that a retry spends credits again. The reader of
 * this text is the owner in the review editor. `unconfirmed` is a switch
 * call with no usable answer from the database, so it may have saved;
 * `readerRoute` is the reader page to check it on.
 */
function afterSpendError(
  step: Step,
  bubbleId: string,
  hadAudio: boolean,
  message: string,
  readerRoute = "",
) {
  const saved =
    step === "generate"
      ? `Generating audio for bubble ${bubbleId} failed (${message}), and ElevenLabs may have charged for it.`
      : step === "upload"
        ? `Audio for bubble ${bubbleId} was generated and paid for, but the Storage upload failed (${message}), so nothing was saved${hadAudio ? " and the reader still plays the old audio with its own timings." : `.${PIPELINE_AGAIN}`}`
        : step === "switch"
          ? `Audio for bubble ${bubbleId} was generated and paid for, but its word timings and audio path did not save (${message}), so nothing was saved${hadAudio ? " and the reader still plays the old audio with its own timings." : `.${PIPELINE_AGAIN}`}`
          : step === "unconfirmed"
            ? `Audio for bubble ${bubbleId} was generated and paid for, but saving its word timings and audio path got no usable answer from the database (${message}), so it may still have saved. ${hadAudio ? "The reader plays either the old take or the new one, each with its own timings." : "The bubble has either no audio or the new take with its own timings."} Open ${readerRoute} and tap the bubble to hear which.${hadAudio ? "" : " If it has no audio, the next pipeline audio run will generate this bubble again and spend credits."}`
            : `The new audio and word timings for bubble ${bubbleId} are saved, but the page refresh failed (${message}), so the reader may ${hadAudio ? "play the old take" : "show this bubble with no audio"} for up to a day.`;
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
      "id, legacy_id, speaker, character_id, ocr_text, text_with_cues, type, ignored, audio_storage_path, page_number, book_id, issue_id",
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
    character_id: string | null;
    ocr_text: string | null;
    text_with_cues: string | null;
    type: string;
    ignored: boolean | null;
    audio_storage_path: string | null;
    page_number: number;
  };
  const b = bubble as BubbleRow;

  if (b.ignored) {
    return { ok: false, error: "Bubble is ignored — cannot regenerate audio" };
  }
  if (!b.speaker && !b.character_id) {
    return { ok: false, error: "No speaker assigned" };
  }
  const text = b.text_with_cues ?? b.ocr_text ?? "";
  if (!text.trim()) {
    return { ok: false, error: "Empty text" };
  }

  // The audio step's render chain, keyed on bubbles.character_id.
  let book;
  try {
    book = await loadBookCast(supabaseAdmin, args.bookId);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const resolved = resolveSpeakerVoice(book, args.issueId, {
    speaker: b.speaker,
    character_id: b.character_id,
  });
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  const voiceId = resolved.voiceId;
  // The audio step's request: same text, voice and voice settings.
  let request;
  try {
    const overrides = await loadVoiceOverrides(supabaseAdmin, [voiceId]);
    request = buildTtsRequest({
      text,
      voiceId,
      override: overrides.get(voiceId),
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // Each take goes to a path no earlier take used, so the upload never
  // touches what the reader plays. switch_bubble_audio_take then changes the
  // timings row and bubbles.audio_storage_path in one transaction: until it
  // commits, the reader has the old take and its own timings. The old object
  // is never removed: a page cached before the switch still carries the old
  // path with the old timings, and that pair keeps playing correctly.
  const hadAudio = b.audio_storage_path != null;
  const storagePath = `${b.id}-take-${randomUUID().slice(0, 8)}.mp3`;
  const remotePath = `${args.bookId}/${args.issueId}/${storagePath}`;
  // A concrete URL with no type: its tag is the page's own pathname tag.
  const readerRoute = `/book/${args.bookId}/${args.issueId}/${b.page_number}`;

  /** The switch may have saved: refresh the reader page so it shows which. */
  function unconfirmed(message: string) {
    try {
      revalidatePath(readerRoute);
    } catch (e) {
      console.warn(
        `[regenerate-audio] could not refresh ${readerRoute} (${(e as Error).message})`,
      );
    }
    return afterSpendError("unconfirmed", b.id, hadAudio, message, readerRoute);
  }

  let step: Step = "generate";
  try {
    const client = new ElevenLabsClient({
      apiKey: process.env.ELEVENLABS_API_KEY,
    });
    const response = await recordElevenLabsCall(
      {
        step: "review:regenerate-audio",
        bookId: args.bookId,
        issueId: args.issueId,
        model: TTS_MODEL,
      },
      request.text.length,
      () => client.textToSpeech.convertWithTimestamps(voiceId, request),
    );
    const audioBuffer = Buffer.from(response.audioBase64, "base64");

    const alignment = normalizeAlignment(
      response.alignment as AlignmentRaw | null | undefined,
    );
    const normalizedAlignment = normalizeAlignment(
      response.normalizedAlignment as AlignmentRaw | null | undefined,
    );

    step = "upload";
    const { error: upErr } = await supabaseAdmin.storage
      .from(AUDIO_BUCKET)
      .upload(remotePath, audioBuffer, {
        contentType: "audio/mpeg",
        upsert: false,
      });
    if (upErr) {
      return afterSpendError(step, b.id, hadAudio, upErr.message);
    }

    step = "switch";
    const { error: switchErr, status } = await supabaseAdmin.rpc(
      "switch_bubble_audio_take",
      {
        p_bubble_id: b.id,
        p_book_id: args.bookId,
        p_issue_id: args.issueId,
        p_audio_storage_path: storagePath,
        p_alignment: alignment,
        p_normalized_alignment: normalizedAlignment,
      },
    );
    if (switchErr) {
      // Only a coded answer below 500 proves the rollback. With no code,
      // status 0 or a 5xx the transaction may still commit, so the new take
      // stays.
      if (!switchErr.code || status === 0 || status >= 500) {
        return unconfirmed(switchErr.message);
      }
      const { error: rmErr } = await supabaseAdmin.storage
        .from(AUDIO_BUCKET)
        .remove([remotePath])
        .catch((e: Error) => ({ error: e }));
      if (rmErr) {
        console.warn(
          `[regenerate-audio] could not remove unused ${remotePath} (${rmErr.message})`,
        );
      }
      return afterSpendError(step, b.id, hadAudio, switchErr.message);
    }

    step = "refresh";
    revalidatePath(readerRoute);

    return {
      ok: true,
      audioStoragePath: storagePath,
    };
  } catch (e) {
    // A throw from the switch call is an unanswered call too.
    if (step === "switch") return unconfirmed((e as Error).message);
    return afterSpendError(step, b.id, hadAudio, (e as Error).message);
  }
}
