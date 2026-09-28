import { createHash } from "node:crypto";
import type { ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { logSpend } from "./dry-run";

/**
 * One silent MPEG-1 Layer III frame: 32 kbps, 44.1 kHz, mono, 104 bytes.
 * Zeroed side info decodes as silence; frames concatenate cleanly.
 */
const SILENT_FRAME = Buffer.concat([
  Buffer.from([0xff, 0xfb, 0x10, 0xc4]),
  Buffer.alloc(100),
]);
const FRAME_SECONDS = 1152 / 44100;
const SECONDS_PER_CHAR = 0.06;

function fakeTts(text: string): ElevenLabs.AudioWithTimestampsResponse {
  logSpend("elevenlabs", "characters", text.length, "(tts)");
  const chars = [...text];
  const frames = Math.max(
    1,
    Math.ceil((chars.length * SECONDS_PER_CHAR) / FRAME_SECONDS),
  );
  const step = (frames * FRAME_SECONDS) / Math.max(1, chars.length);
  const alignment = {
    characters: chars,
    characterStartTimesSeconds: chars.map((_, i) => +(i * step).toFixed(3)),
    characterEndTimesSeconds: chars.map((_, i) => +((i + 1) * step).toFixed(3)),
  };
  return {
    audioBase64: Buffer.concat(Array(frames).fill(SILENT_FRAME)).toString(
      "base64",
    ),
    alignment,
    normalizedAlignment: alignment,
  };
}

export const fakeElevenLabsClient = {
  textToSpeech: {
    convertWithTimestamps: async (
      _voiceId: string,
      request: { text: string },
    ) => fakeTts(request.text),
  },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function fakeElevenLabsFetch(path: string, init: RequestInit): Response {
  const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
    voice_description?: string;
    voice_name?: string;
  };
  const tag = createHash("sha256")
    .update(`${body.voice_name ?? ""}:${body.voice_description ?? ""}`)
    .digest("hex")
    .slice(0, 12);

  if (path === "/v1/text-to-voice/design") {
    const chars = body.voice_description?.length ?? 0;
    logSpend("elevenlabs", "characters", chars, "(voice design)");
    return json({
      previews: [{ generated_voice_id: `dry-run-preview-${tag}` }],
    });
  }
  if (path === "/v1/text-to-voice") {
    logSpend("elevenlabs", "voice-slot", 1, "(voice create)");
    return json({ voice_id: `dry-run-voice-${tag}` });
  }
  throw new Error(`DRY_RUN: no ElevenLabs fixture for ${path}`);
}
