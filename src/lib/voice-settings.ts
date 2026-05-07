export interface VoiceSettings {
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
}

export function getVoiceSettingsFromEmotion(emotion: string): VoiceSettings {
  const e = emotion.toLowerCase().trim();

  let stability = 0.5;
  let style = 0.0;
  let speed = 1.0;

  if (
    e.includes("angry") ||
    e.includes("furious") ||
    e.includes("rage") ||
    e.includes("shouting") ||
    e.includes("screaming") ||
    e.includes("yelling") ||
    e.includes("ecstatic") ||
    e.includes("terrified") ||
    e.includes("distraught")
  ) {
    stability = 0.0;
    style = 0.5;
    speed = 1.1;
  } else if (
    e.includes("sarcastic") ||
    e.includes("mocking") ||
    e.includes("snide")
  ) {
    stability = 0.0;
    style = 0.5;
    speed = 1.0;
  } else if (
    e.includes("sad") ||
    e.includes("depressed") ||
    e.includes("melancholy") ||
    e.includes("upset") ||
    e.includes("excited") ||
    e.includes("enthusiastic") ||
    e.includes("happy") ||
    e.includes("joyful") ||
    e.includes("surprised") ||
    e.includes("shocked") ||
    e.includes("astonished") ||
    e.includes("fear") ||
    e.includes("afraid") ||
    e.includes("anxious") ||
    e.includes("nervous")
  ) {
    stability = 0.0;
    style = 0.3;
    speed =
      e.includes("sad") || e.includes("depressed")
        ? 0.9
        : e.includes("excited") || e.includes("happy")
          ? 1.1
          : 1.0;
  } else if (
    e.includes("whisper") ||
    e.includes("quiet") ||
    e.includes("hushed")
  ) {
    stability = 0.5;
    style = 0.0;
    speed = 0.95;
  } else if (
    e.includes("stoic") ||
    e.includes("calm") ||
    e.includes("neutral") ||
    e.includes("firm") ||
    e.includes("defiant")
  ) {
    stability = 1.0;
    style = 0.0;
    speed = 1.0;
  }

  return { stability, similarityBoost: 0.75, style, speed };
}

export const SKIPPED_VOICE = "__SKIPPED__";
