import type { AudioTimestamps, Bubble, CharacterAlignment } from "~/types";

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
 *
 * The clean text is built in the same pass as the offsets, following the
 * `stripAudioTags` rules (tags dropped, whitespace runs collapsed to one
 * space, no leading or trailing space), so every `cleanTextStart` and
 * `cleanTextEnd` indexes into it as-is. Never post-process `cleanText` after
 * this loop: any trim or collapse would shift the offsets.
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
  let charEndIndex = 0;
  let cleanTextStart = 0;
  // Whitespace seen since the last kept character; written as one space only
  // when another kept character follows, which collapses runs and trims.
  let pendingSpace = false;
  let cleanText = "";

  const pushWord = () => {
    if (!buffer || wordStartTime === null || wordEndTime === null) return;
    words.push({
      word: buffer,
      start: wordStartTime,
      end: wordEndTime,
      charStartIndex,
      charEndIndex,
      cleanTextStart,
      cleanTextEnd: cleanText.length,
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

    if (/\s/.test(ch)) {
      // Whitespace ends a word
      pushWord();
      pendingSpace = true;
      continue;
    }

    if (pendingSpace && cleanText) cleanText += " ";
    pendingSpace = false;

    if (!buffer) {
      wordStartTime = start;
      charStartIndex = i;
      cleanTextStart = cleanText.length;
    }

    cleanText += ch;
    buffer += ch;
    wordEndTime = end;
    charEndIndex = i;
  }

  // Flush the last word, including one followed only by a tag
  pushWord();

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

/** Longest run of bubble text a bubble button's accessible name carries. */
const ACCESSIBLE_NAME_TEXT_LIMIT = 80;

/** What a bubble is called when it has no text to speak, by its type. */
const BUBBLE_KIND_LABEL: Partial<Record<string, string>> = {
  SPEECH: "Speech bubble",
  NARRATION: "Narration box",
  CAPTION: "Caption",
  SFX: "Sound effect",
  BACKGROUND: "Background text",
};

/** Cuts `text` to at most `limit` characters, at a word break when one falls in the second half. */
function shortenAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * The accessible name of a bubble button: what a screen reader speaks when
 * a kid lands on it (#550). The speaker and the start of the text when the
 * bubble has them, else the kind of bubble, and never the database id.
 */
export function bubbleAccessibleName(
  bubble: Pick<Bubble, "speakerName" | "speaker" | "ocr_text" | "type">,
): string {
  const speaker = (bubble.speakerName ?? bubble.speaker ?? "").trim();
  const text = shortenAtWord(
    stripAudioTags(bubble.ocr_text ?? ""),
    ACCESSIBLE_NAME_TEXT_LIMIT,
  );
  if (speaker && text) return `${speaker}: ${text}`;
  if (text) return text;
  const kind = BUBBLE_KIND_LABEL[bubble.type] ?? "Bubble";
  return speaker ? `${speaker}'s ${kind.toLowerCase()}` : kind;
}
