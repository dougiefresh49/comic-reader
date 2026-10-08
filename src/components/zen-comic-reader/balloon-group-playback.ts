/**
 * Joined balloons in the reader (#451): which balloons on a page play as one
 * group clip, and how that clip's words split among them. Pure functions over
 * the page's bubbles and timestamps; the rule itself lives in
 * `~/lib/balloon-groups`.
 */
import {
  groupLeadId,
  groupPlaysAsUnit,
  memberWordRanges,
} from "~/lib/balloon-groups";
import type { WordSpan } from "~/hooks/useWordHighlight";
import type { AudioTimestamps, Bubble } from "~/types";
import {
  buildWordTimings,
  stripAudioTags,
  type SpeechContent,
  type WordTiming,
} from "./text-utils";

/** A group that plays as one clip: the lead's, from the lead's alignment. */
export interface GroupUnit {
  lead: Bubble;
  /** Members in play order, lead first. */
  memberIds: string[];
  /** The group clip's words (`buildWordTimings` on the lead's alignment). */
  words: WordTiming[];
  cleanText: string;
  /** Each member's words; null when the counts do not add up, and then the lead lights every word. */
  spans: WordSpan[] | null;
}

/**
 * Every group on the page that plays as one clip, keyed by each member's id.
 * Members are the bubbles sharing a `groupId`, in `sortOrder` (the list
 * position when it is missing, since the page query orders by it). A group
 * of one, or one not yet rendered (`groupPlaysAsUnit`), is left out: its
 * balloons play their own clips.
 */
export function findGroupUnits(
  bubbles: Bubble[],
  timestamps: Record<string, AudioTimestamps>,
): Map<string, GroupUnit> {
  const byGroup = new Map<
    string,
    Array<{ bubble: Bubble; sortOrder: number }>
  >();
  bubbles.forEach((bubble, i) => {
    if (!bubble.groupId) return;
    const entries = byGroup.get(bubble.groupId) ?? [];
    entries.push({ bubble, sortOrder: bubble.sortOrder ?? i });
    byGroup.set(bubble.groupId, entries);
  });

  const units = new Map<string, GroupUnit>();
  for (const entries of byGroup.values()) {
    if (entries.length < 2) continue;
    const members = entries.map(({ bubble, sortOrder }) => ({
      id: bubble.id,
      sortOrder,
      audioStoragePath: bubble.audioStoragePath ?? null,
      hasTimestamps: Boolean(timestamps[bubble.id]),
    }));
    if (!groupPlaysAsUnit(members)) continue;

    // Play order, ties on the id: the order `groupLeadId` and the render use.
    entries.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        (a.bubble.id < b.bubble.id ? -1 : a.bubble.id > b.bubble.id ? 1 : 0),
    );
    const leadId = groupLeadId(members);
    const lead = entries.find((e) => e.bubble.id === leadId)!.bubble;
    const ts = timestamps[leadId];
    const { cleanText, words } = buildWordTimings(
      ts?.normalized_alignment ?? ts?.alignment ?? null,
    );
    // The text each member was rendered from, in the order the clip joined it.
    const ranges = memberWordRanges(
      entries.map((e) => e.bubble.textWithCues ?? e.bubble.ocr_text),
      words.length,
    );
    const unit: GroupUnit = {
      lead,
      memberIds: entries.map((e) => e.bubble.id),
      words,
      cleanText,
      spans:
        ranges?.map((range, k) => ({
          bubbleId: entries[k]!.bubble.id,
          ...range,
        })) ?? null,
    };
    for (const e of entries) units.set(e.bubble.id, unit);
  }
  return units;
}

/**
 * Where a tap on `bubbleId` starts the group clip: its first word. The lead,
 * and every member when there are no spans, start at 0, the clip's start.
 */
export function memberStartSeconds(unit: GroupUnit, bubbleId: string): number {
  const span = unit.spans?.find((s) => s.bubbleId === bubbleId);
  if (!span || span.start === 0) return 0;
  return unit.words[span.start]?.start ?? 0;
}

/**
 * A member's caption and highlight words: its slice of the group clip, with
 * text offsets rebased to the slice, so index N means the same word in the
 * caption, on the art and in the highlight store. With no spans the lead
 * carries the whole clip and the others their own text.
 */
export function memberSpeech(unit: GroupUnit, bubble: Bubble): SpeechContent {
  if (!unit.spans) {
    return bubble.id === unit.lead.id
      ? { cleanText: unit.cleanText, words: unit.words }
      : { cleanText: stripAudioTags(bubble.ocr_text), words: [] };
  }
  const span = unit.spans.find((s) => s.bubbleId === bubble.id);
  const slice = span ? unit.words.slice(span.start, span.end) : [];
  const first = slice[0];
  const last = slice[slice.length - 1];
  if (!first || !last) {
    return { cleanText: stripAudioTags(bubble.ocr_text), words: [] };
  }
  const base = first.cleanTextStart;
  return {
    cleanText: unit.cleanText.slice(base, last.cleanTextEnd),
    words: slice.map((w) => ({
      ...w,
      cleanTextStart: w.cleanTextStart - base,
      cleanTextEnd: w.cleanTextEnd - base,
    })),
  };
}

/** A member's own text, for its button's accessible name: never the whole group's. */
export function memberOwnText(unit: GroupUnit, bubble: Bubble): string {
  return unit.spans
    ? memberSpeech(unit, bubble).cleanText
    : stripAudioTags(bubble.ocr_text);
}

/**
 * An autoplay list with each group as one entry, its lead: the other
 * members drop out, so the bubble after the lead is the one after the group.
 */
export function collapseGroups(
  list: Bubble[],
  units: Map<string, GroupUnit>,
): Bubble[] {
  return list.filter((b) => {
    const unit = units.get(b.id);
    return !unit || unit.lead.id === b.id;
  });
}
