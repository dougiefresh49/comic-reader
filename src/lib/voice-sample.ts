/**
 * The voice stop's Make a sample (#880): the one line a sample says, what it
 * costs, and where it is stored. Pure, so the preview lookup and the render
 * read the same line; the price takes the billed rate its caller measured.
 */
import { estimateCredits, type TtsCreditRate } from "~/lib/tts-credit-rate";

/** Neutral on purpose: any character can say it. */
export const VOICE_SAMPLE_LINE =
  "Hi there! This is my voice. Let's read a comic together.";

/**
 * About what a sample costs, rounded up: the request's text (the line plus
 * any line prefix the voice adds) at the measured billed rate (#921). Null
 * when no rate is measured; the button then states the characters instead.
 */
export function sampleCredits(
  requestText: string,
  rate: TtsCreditRate | null,
): number | null {
  return rate ? estimateCredits(requestText.length, rate) : null;
}

/** The stored sample's object path in `comic-voice-clips`, by `voices.id`. */
export function voiceSamplePath(voiceId: string): string {
  return `samples/${voiceId}.mp3`;
}
