import type { AudioTimestamps, CharacterAlignment } from "~/types";

export interface WordTiming {
  word: string;
  start: number;
  end: number;
  charStartIndex: number;
  charEndIndex: number;
  cleanTextStart: number;
  cleanTextEnd: number;
}

export interface SpeechContent {
  cleanText: string;
  words: WordTiming[];
}

const MIN_TIME = 0;

export const stripAudioTags = (value: string): string =>
  value
    .replace(/\[[^\]]*]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Build word-level timings from ElevenLabs character alignment while
 * simultaneously producing a cleaned text string with audio tags removed.
 */
export function buildWordTimings(
  alignment?: CharacterAlignment | null,
): SpeechContent {
  if (
    !alignment ||
    !Array.isArray(alignment.characters) ||
    !Array.isArray(alignment.character_start_times_seconds) ||
    !Array.isArray(alignment.character_end_times_seconds)
  ) {
    return { cleanText: "", words: [] };
  }

  const {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  } = alignment;

  const words: WordTiming[] = [];
  let buffer = "";
  let inTag = false;
  let wordStartTime: number | null = null;
  let wordEndTime: number | null = null;
  let charStartIndex = 0;
  let cleanTextStart = 0;
  const cleanBuilder: string[] = [];

  const pushWord = (currentIndex: number, cleanIndex: number) => {
    if (!buffer || wordStartTime === null || wordEndTime === null) return;
    words.push({
      word: buffer,
      start: wordStartTime ?? MIN_TIME,
      end: wordEndTime ?? wordStartTime ?? MIN_TIME,
      charStartIndex,
      charEndIndex: currentIndex,
      cleanTextStart,
      cleanTextEnd: cleanIndex,
    });
    buffer = "";
    wordStartTime = null;
    wordEndTime = null;
  };

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i] ?? "";
    const start = starts[i] ?? MIN_TIME;
    const end = ends[i] ?? start;

    if (ch === "[") {
      inTag = true;
      continue;
    }
    if (inTag) {
      if (ch === "]") {
        inTag = false;
      }
      continue;
    }

    const isWhitespace = /\s/.test(ch);

    // Always mirror the raw (tagless) characters into the clean text builder
    cleanBuilder.push(ch);

    if (isWhitespace) {
      // Whitespace ends a word
      pushWord(i - 1, cleanBuilder.length - 1);
      cleanTextStart = cleanBuilder.length;
      continue;
    }

    if (!buffer) {
      wordStartTime = start;
      charStartIndex = i;
      cleanTextStart = cleanBuilder.length - 1;
    }

    buffer += ch;
    wordEndTime = end;

    // If it's the last character, flush
    if (i === characters.length - 1) {
      pushWord(i, cleanBuilder.length);
    }
  }

  const cleanText = stripAudioTags(cleanBuilder.join(""));

  return { cleanText, words };
}

/**
 * Creates a speech payload from timestamps and the fallback bubble text.
 * If timestamps are missing, we still return cleaned text but no timings.
 */
export function buildSpeechContent(
  timestamps: AudioTimestamps | undefined,
  fallbackText: string,
): SpeechContent {
  const alignment =
    timestamps?.normalized_alignment ?? timestamps?.alignment ?? null;

  const { cleanText, words } = buildWordTimings(alignment);
  if (words.length) {
    return { cleanText, words };
  }

  const cleanedFallback = stripAudioTags(fallbackText);
  return { cleanText: cleanedFallback, words: [] };
}
