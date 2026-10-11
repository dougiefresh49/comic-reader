/**
 * One render for a single bubble: its line spoken in its speaker's voice,
 * stored as a new take and switched in. The review editor's regenerate and
 * `scripts/recue-issue.ts --apply` both call this one function; a joined
 * group renders through `renderGroupAudio` instead.
 *
 * The voice is the audio step's render chain (`resolveSpeakerVoice` on
 * `bubbles.character_id`), with the voice's stored settings
 * (`loadVoiceOverrides`) and `buildTtsRequest`. Each take goes to a path no
 * earlier take used (`upsert: false`), so the upload never touches what the
 * reader plays. `switch_bubble_audio_take` then changes the timings row and
 * `bubbles.audio_storage_path` in one transaction: until it commits, the
 * reader has the old take and its own timings. The old object is never
 * removed: a reader page a kid loaded before the switch is still open with
 * the old path and the old timings, and that pair keeps playing correctly.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBookCast, type BookCast } from "~/lib/cast";
import { getElevenLabsClient } from "~/lib/elevenlabs-client";
import { recordElevenLabsCall } from "~/lib/llm-usage";
import { buildTtsRequest, TTS_MODEL } from "~/lib/tts-request";
import { loadVoiceOverrides } from "~/lib/voice-overrides";
import { resolveSpeakerVoice } from "~/server/actions/review/resolve-castlist-row";
import {
  normalizeAlignment,
  type AlignmentRaw,
} from "~/workflows/steps/audio-plan";

const AUDIO_BUCKET = "comic-audio";

export type BubbleRenderResult =
  | {
      rendered: true;
      /** The take's file name, as `audio_storage_path` stores it. */
      path: string;
      /** Characters billed: the request text, voice prefix included. */
      characters: number;
    }
  /** Neither `text_with_cues` nor `ocr_text` has anything to speak. */
  | { skipped: "no-text" }
  /** The speaker has no voice to render with; `detail` names the case. */
  | { skipped: "no-voice"; detail: string };

/**
 * A failure at or after the paid call. `stage` says what the reader plays
 * now: before "switch" nothing changed; "unconfirmed" means the switch got
 * no usable answer and may have landed.
 */
export class BubbleRenderError extends Error {
  constructor(
    readonly stage: "generate" | "upload" | "switch" | "unconfirmed",
    message: string,
  ) {
    super(message);
    this.name = "BubbleRenderError";
  }
}

export async function renderBubbleAudio({
  client,
  bookId,
  issueId,
  bubble,
  step,
  book,
}: {
  /** A service-role client: the switch RPC is granted to service_role only. */
  client: SupabaseClient;
  bookId: string;
  issueId: string;
  bubble: {
    id: string;
    speaker: string | null;
    character_id: string | null;
    text_with_cues: string | null;
    ocr_text: string | null;
  };
  /** The `llm_calls.step` the spend is recorded under. */
  step: string;
  /** The book's cast when the caller has it loaded already. */
  book?: BookCast;
}): Promise<BubbleRenderResult> {
  const text = bubble.text_with_cues ?? bubble.ocr_text ?? "";
  if (!text.trim()) return { skipped: "no-text" };

  const cast = book ?? (await loadBookCast(client, bookId));
  const resolved = resolveSpeakerVoice(cast, issueId, bubble);
  if (!resolved.ok) return { skipped: "no-voice", detail: resolved.error };
  const voiceId = resolved.voiceId;
  const overrides = await loadVoiceOverrides(client, [voiceId]);
  const request = buildTtsRequest({
    text,
    voiceId,
    override: overrides.get(voiceId),
  });

  let response;
  try {
    const tts = await getElevenLabsClient();
    response = await recordElevenLabsCall(
      { step, bookId, issueId, model: TTS_MODEL },
      request.text.length,
      () => tts.textToSpeech.convertWithTimestamps(voiceId, request),
    );
  } catch (e) {
    throw new BubbleRenderError("generate", (e as Error).message);
  }

  const path = `${bubble.id}-take-${randomUUID().slice(0, 8)}.mp3`;
  const remotePath = `${bookId}/${issueId}/${path}`;
  try {
    const { error: upErr } = await client.storage
      .from(AUDIO_BUCKET)
      .upload(remotePath, Buffer.from(response.audioBase64, "base64"), {
        contentType: "audio/mpeg",
        upsert: false,
      });
    if (upErr) throw upErr;
  } catch (e) {
    throw new BubbleRenderError("upload", (e as Error).message);
  }

  let switched;
  try {
    switched = await client.rpc("switch_bubble_audio_take", {
      p_bubble_id: bubble.id,
      p_book_id: bookId,
      p_issue_id: issueId,
      p_audio_storage_path: path,
      p_voice_id: resolved.voiceUuid,
      p_alignment: normalizeAlignment(
        response.alignment as AlignmentRaw | null | undefined,
      ),
      p_normalized_alignment: normalizeAlignment(
        response.normalizedAlignment as AlignmentRaw | null | undefined,
      ),
    });
  } catch (e) {
    // A throw from the switch call is an unanswered call too.
    throw new BubbleRenderError("unconfirmed", (e as Error).message);
  }
  const { error: switchErr, status } = switched;
  if (switchErr) {
    // Only a coded answer below 500 proves the rollback. With no code,
    // status 0 or a 5xx the transaction may still commit, so the take stays.
    if (!switchErr.code || status === 0 || status >= 500)
      throw new BubbleRenderError("unconfirmed", switchErr.message);
    const { error: rmErr } = await client.storage
      .from(AUDIO_BUCKET)
      .remove([remotePath])
      .catch((e: Error) => ({ error: e }));
    if (rmErr)
      console.warn(
        `[bubble-audio] could not remove unused ${remotePath} (${rmErr.message})`,
      );
    throw new BubbleRenderError("switch", switchErr.message);
  }

  return { rendered: true, path, characters: request.text.length };
}
