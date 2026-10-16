/**
 * The content key of a TTS render (#106): what changes the sound, and
 * nothing else. The voice, the model, the settings and the text as sent
 * (voice prefix included, since `buildTtsRequest` adds it), plus the context
 * texts when they are sent, since those change the delivery too. Not the
 * bubble id: two bubbles with the same request sound the same.
 *
 * `bubbles.audio_hash` stores it beside `audio_storage_path`, written by the
 * switch RPCs, so a regenerate whose request hashes the same can skip the
 * paid call.
 */
import { createHash } from "node:crypto";
import type { TtsRequest } from "~/lib/tts-request";

export function audioHash(voiceId: string, req: TtsRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        voiceId,
        req.modelId,
        req.voiceSettings,
        req.text,
        req.previousText ?? null,
        req.nextText ?? null,
      ]),
    )
    .digest("hex");
}
