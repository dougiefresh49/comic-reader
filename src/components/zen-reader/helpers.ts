import type { CharacterAlignment } from "~/types";

export interface WordTiming {
  index: number;
  text: string;
  start: number;
  end: number;
}

const WORD_CHAR_REGEX = /[A-Za-z0-9'’\-]/;

export function stripAudioTags(text: string): string {
  if (!text) return "";
  return text.replace(/\[[^\]]*?\]\s*/g, "").trim();
}

export function buildWordTimings(
  alignment?: CharacterAlignment | null,
): WordTiming[] {
  if (!alignment) return [];

  const chars = alignment.characters ?? [];
  const starts = alignment.character_start_times_seconds ?? [];
  const ends = alignment.character_end_times_seconds ?? [];

  const words: WordTiming[] = [];
  let buffer = "";
  let startTime: number | null = null;
  let endTime: number | null = null;
  let insideTag = false;
  let wordIndex = 0;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? "";
    const charStart = starts[i] ?? starts[i - 1] ?? 0;
    const charEnd = ends[i] ?? charStart;

    if (char === "[") {
      insideTag = true;
      continue;
    }
    if (char === "]") {
      insideTag = false;
      continue;
    }
    if (insideTag) continue;

    const isWordChar = WORD_CHAR_REGEX.test(char);
    if (isWordChar) {
      if (buffer.length === 0) {
        startTime = charStart;
      }
      buffer += char;
      endTime = charEnd;
      continue;
    }

    if (buffer && startTime !== null && endTime !== null) {
      words.push({
        index: wordIndex,
        text: buffer,
        start: startTime,
        end: endTime,
      });
      wordIndex += 1;
      buffer = "";
      startTime = null;
      endTime = null;
    }
  }

  if (buffer && startTime !== null && endTime !== null) {
    words.push({
      index: wordIndex,
      text: buffer,
      start: startTime,
      end: endTime,
    });
  }

  return words;
}

export function tokenizeCleanText(cleanText: string): Array<{
  text: string;
  isWord: boolean;
}> {
  if (!cleanText) return [];
  const tokens = cleanText.match(/\w+['’\-]?\w*|[^\w\s]+|\s+/g) ?? [
    cleanText.trim(),
  ];
  return tokens.map((token) => ({
    text: token,
    isWord: WORD_CHAR_REGEX.test(token[0] ?? ""),
  }));
}
