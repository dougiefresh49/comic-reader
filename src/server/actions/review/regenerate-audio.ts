"use server";

import { randomUUID } from "node:crypto";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { checkAdminAuth } from "~/lib/admin-auth";
import { recordElevenLabsCall } from "~/lib/llm-usage";
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

type Step = "generate" | "upload" | "switch" | "unconfirmed" | "refresh";

const PIPELINE_AGAIN =
  " The next pipeline audio run will generate this bubble again and spend credits.";

/**
 * The error for a failure at or after the paid ElevenLabs call: what the
 * reader plays now, and that a retry spends credits again. The reader of
 * this text is the owner in the review editor. `unconfirmed` is a failed
 * switch call whose outcome could not be read back.
 */
function afterSpendError(
  step: Step,
  bubbleId: string,
  hadAudio: boolean,
  message: string,
) {
  const saved =
    step === "generate"
      ? `Generating audio for bubble ${bubbleId} failed (${message}), and ElevenLabs may have charged for it.`
      : step === "upload"
        ? `Audio for bubble ${bubbleId} was generated and paid for, but the Storage upload failed (${message}), so nothing was saved.`
        : step === "switch"
          ? `Audio for bubble ${bubbleId} was generated and paid for, but its word timings and audio path did not save (${message}), so nothing was saved${hadAudio ? " and the reader still plays the old audio with its own timings." : `.${PIPELINE_AGAIN}`}`
          : step === "unconfirmed"
            ? `Audio for bubble ${bubbleId} was generated and paid for, but saving its word timings and audio path returned an error (${message}) and the bubble could not be read back, so the reader plays either the old take or the new one, each with its own timings. Reload the review page to see which.`
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

  // Each take goes to a path no earlier take used, so the upload never
  // touches what the reader plays. switch_bubble_audio_take then changes the
  // timings row and bubbles.audio_storage_path in one transaction: until it
  // commits, the reader has the old take and its own timings.
  const hadAudio = b.audio_storage_path != null;
  const folder = `${args.bookId}/${args.issueId}`;
  const storagePath = `${b.id}-take-${randomUUID().slice(0, 8)}.mp3`;

  /** Best-effort: a failed removal leaves an unused object and is logged. */
  async function removeTake(path: string, why: string) {
    try {
      const { error } = await supabaseAdmin.storage
        .from(AUDIO_BUCKET)
        .remove([`${folder}/${path}`]);
      if (error) throw new Error(error.message);
    } catch (e) {
      console.warn(
        `[regenerate-audio] ${why}: could not remove ${folder}/${path} (${(e as Error).message}), left in Storage unused`,
      );
    }
  }

  /**
   * After the switch call errors. The transaction may still have committed
   * (a lost response), so the row decides: true if it names the new take,
   * false if not, null if it could not be read.
   */
  async function switchLanded(): Promise<boolean | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from("bubbles")
        .select("audio_storage_path")
        .eq("id", b.id)
        .eq("book_id", args.bookId)
        .eq("issue_id", args.issueId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as { audio_storage_path: string | null } | null;
      return row?.audio_storage_path === storagePath;
    } catch (e) {
      console.warn(
        `[regenerate-audio] could not read bubble ${b.id} back after a failed switch (${(e as Error).message})`,
      );
      return null;
    }
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
        model: "eleven_v3",
      },
      text.length,
      () =>
        client.textToSpeech.convertWithTimestamps(voiceId, {
          modelId: "eleven_v3",
          text,
        }),
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
      .upload(`${folder}/${storagePath}`, audioBuffer, {
        contentType: "audio/mpeg",
        upsert: false,
      });
    if (upErr) {
      return afterSpendError(step, b.id, hadAudio, upErr.message);
    }

    step = "switch";
    let previousPath: string | null;
    try {
      const res = await supabaseAdmin.rpc("switch_bubble_audio_take", {
        p_bubble_id: b.id,
        p_book_id: args.bookId,
        p_issue_id: args.issueId,
        p_audio_storage_path: storagePath,
        p_alignment: alignment,
        p_normalized_alignment: normalizedAlignment,
      });
      if (res.error) throw new Error(res.error.message);
      // The function returns the audio_storage_path it replaced.
      previousPath = res.data as string | null;
    } catch (e) {
      const message = (e as Error).message;
      const landed = await switchLanded();
      if (landed === null) {
        return afterSpendError("unconfirmed", b.id, hadAudio, message);
      }
      if (!landed) {
        await removeTake(storagePath, "the switch did not commit");
        return afterSpendError(step, b.id, hadAudio, message);
      }
      previousPath = b.audio_storage_path;
    }

    step = "refresh";
    revalidatePath(`/book/${args.bookId}/${args.issueId}`, "page");
    revalidatePath(`/book/${args.bookId}/${args.issueId}/review`, "page");

    if (previousPath && previousPath !== storagePath) {
      await removeTake(previousPath, "old take after the switch");
    }

    return {
      ok: true,
      audioStoragePath: storagePath,
    };
  } catch (e) {
    return afterSpendError(step, b.id, hadAudio, (e as Error).message);
  }
}
