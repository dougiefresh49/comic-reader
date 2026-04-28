"use server";

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";

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

export async function regenerateAudio(args: Args) {
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

  // Look up voice ID
  const { data: castRow } = await supabaseAdmin
    .from("castlist")
    .select("voice_id")
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId)
    .eq("character", b.speaker)
    .maybeSingle();
  const voiceId = (castRow as { voice_id?: string } | null)?.voice_id;
  if (!voiceId) {
    return {
      ok: false,
      error: `No voice ID for speaker '${b.speaker}' in castlist`,
    };
  }

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
    const { error: upErr } = await supabaseAdmin.storage
      .from(AUDIO_BUCKET)
      .upload(remotePath, audioBuffer, {
        contentType: "audio/mpeg",
        upsert: true,
      });
    if (upErr) return { ok: false, error: `upload: ${upErr.message}` };

    const alignment = normalizeAlignment(
      response.alignment as AlignmentRaw | null | undefined,
    );
    const normalizedAlignment = normalizeAlignment(
      response.normalizedAlignment as AlignmentRaw | null | undefined,
    );

    await supabaseAdmin.from("audio_timestamps").upsert(
      {
        bubble_id: b.id,
        book_id: args.bookId,
        issue_id: args.issueId,
        alignment,
        normalized_alignment: normalizedAlignment,
      },
      { onConflict: "bubble_id" },
    );

    await supabaseAdmin
      .from("bubbles")
      .update({
        needs_audio: false,
        audio_storage_path: storagePath,
        updated_at: new Date().toISOString(),
      })
      .eq("id", b.id);

    revalidatePath(`/book/${args.bookId}/${args.issueId}`, "page");
    revalidatePath(`/book/${args.bookId}/${args.issueId}/review`, "page");

    return {
      ok: true,
      audioStoragePath: storagePath,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
