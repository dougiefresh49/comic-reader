import type { ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { isDryRun } from "./fakes/dry-run";
import { fakeElevenLabsClient, fakeElevenLabsFetch } from "./fakes/elevenlabs";

/** The slice of `ElevenLabsClient` the ingest pipeline calls. */
export type ElevenLabsTts = {
  textToSpeech: {
    convertWithTimestamps(
      voiceId: string,
      request: ElevenLabs.BodyTextToSpeechFullWithTimestamps,
    ): Promise<ElevenLabs.AudioWithTimestampsResponse>;
  };
};

/** TTS client with retries off. Under DRY_RUN: silent MP3, no key read. */
export async function getElevenLabsClient(): Promise<ElevenLabsTts> {
  if (isDryRun()) return fakeElevenLabsClient;
  const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
  return new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY,
    maxRetries: 0,
  });
}

/**
 * `fetch` against `https://api.elevenlabs.io<path>` with the key header set.
 * Under DRY_RUN it answers the Voice Design and create paths from fixtures.
 */
export async function elevenLabsFetch(
  path: string,
  init: RequestInit,
): Promise<Response> {
  if (isDryRun()) return fakeElevenLabsFetch(path, init);
  const headers = new Headers(init.headers);
  headers.set("xi-api-key", process.env.ELEVENLABS_API_KEY ?? "");
  return globalThis.fetch(`https://api.elevenlabs.io${path}`, {
    ...init,
    headers,
  });
}
