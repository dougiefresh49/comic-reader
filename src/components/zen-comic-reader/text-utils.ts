import type { AudioTimestamps, Bubble, CharacterAlignment } from "~/types";
import type { BubbleType } from "~/lib/bubble-types";

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
 * How many words `buildWordTimings` finds in `text` when ElevenLabs speaks
 * it: the same pass over an alignment of its characters, so whitespace splits
 * words and `[tag]` text is skipped exactly as the reader's highlight does.
 */
export function countSpokenWords(text: string): number {
  const characters = Array.from(text);
  const times = characters.map(() => MIN_TIME);
  return buildWordTimings({
    characters,
    character_start_times_seconds: times,
    character_end_times_seconds: times,
  }).words.length;
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

/**
 * What a bubble is called when it has no text to speak, by its type. Only
 * the spoken types reach a bubble button (`visibleBubbles` in the reader).
 */
const BUBBLE_KIND_LABEL: Partial<Record<BubbleType, string>> = {
  SPEECH: "Speech bubble",
  NARRATION: "Narration box",
  CAPTION: "Caption",
};

/** Cuts `text` to at most `limit` characters, at a word break when one falls in the second half. */
function shortenAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // One past the limit, so a word that ends exactly at the limit is kept.
  const lastSpace = text.slice(0, limit + 1).lastIndexOf(" ");
  return (
    lastSpace > limit / 2 ? text.slice(0, lastSpace) : text.slice(0, limit)
  ).trimEnd();
}

/**
 * The bubble's own speaker as the reader names it: the character's display
 * name, else the raw speaker. Empty means the bubble has no speaker (#494).
 */
export function bubbleSpeaker(
  bubble: Pick<Bubble, "speakerName" | "speaker">,
): string {
  return (bubble.speakerName ?? bubble.speaker ?? "").trim();
}

/**
 * The accessible name of a bubble button: what a screen reader speaks when
 * a kid lands on it (#550). The speaker and the start of the text when the
 * bubble has them, else the kind of bubble, and never the database id.
 * `text` is the caption box's text for the bubble, already cleaned: the
 * alignment text when it has audio, else its stripped OCR text (#605).
 */
export function bubbleAccessibleName(
  bubble: Pick<Bubble, "speakerName" | "speaker" | "type">,
  text: string,
): string {
  const speaker = bubbleSpeaker(bubble);
  const shortText = shortenAtWord(text, ACCESSIBLE_NAME_TEXT_LIMIT);
  if (speaker && shortText) return `${speaker}: ${shortText}`;
  if (shortText) return shortText;
  const kind = BUBBLE_KIND_LABEL[bubble.type] ?? "Bubble";
  return speaker ? `${speaker}'s ${kind.toLowerCase()}` : kind;
}
