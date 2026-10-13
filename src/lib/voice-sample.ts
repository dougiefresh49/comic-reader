/**
 * The voice stop's Make a sample (#880): the one line a sample says, what it
 * costs, and where it is stored. Pure, so the preview lookup and the render
 * read the same line and the same price.
 */
import { ELEVENLABS_CREDITS_PER_CHARACTER } from "~/lib/models";
import { TTS_MODEL } from "~/lib/tts-request";

/** Neutral on purpose: any character can say it. */
export const VOICE_SAMPLE_LINE =
  "Hi there! This is my voice. Let's read a comic together.";

/**
 * About what a sample costs, rounded up: the request's text (the line plus
 * any line prefix the voice adds) at the TTS model's rate. Null when the
 * model has no recorded rate.
 */
export function sampleCredits(requestText: string): number | null {
  const rate = ELEVENLABS_CREDITS_PER_CHARACTER[TTS_MODEL];
  return rate === undefined ? null : Math.ceil(requestText.length * rate);
}

/** The stored sample's object path in `comic-voice-clips`, by `voices.id`. */
export function voiceSamplePath(voiceId: string): string {
  return `samples/${voiceId}.mp3`;
}
