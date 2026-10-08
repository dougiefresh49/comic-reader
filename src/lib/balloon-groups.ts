/**
 * Joined balloons (#451): one line split across touching balloons plays as
 * one unit. This module is the rule, as pure functions over plain data (no
 * Supabase, no React, no I/O), so the pipeline step, the review editor and
 * the reader all call the same code.
 *
 * The finder rule comes from the round-2 bench on issue-1 pages 3 to 13
 * (`scripts/bench/bench-joined-balloons.ts`): stored speaker plus a gap of at
 * most 40 px found 27 true joins, 3 false joins and 1 miss against the
 * owner-confirmed list; 50 px adds no false join. Two of the three false
 * joins were caption-on-caption, so only SPEECH balloons join automatically.
 *
 * Storage (`bubbles.group_id`): members share the id, the lead is the member
 * with the lowest `sort_order`, the lead's `audio_timestamps` row holds the
 * group alignment and every member stores the group clip's path.
 */
import { countSpokenWords } from "~/components/zen-comic-reader/text-utils";
import type { RoleId } from "~/lib/cast";

/** A balloon's box in page pixels. */
export type GroupBox = { x: number; y: number; width: number; height: number };

/** The widest edge-to-edge gap, in page pixels, at which two balloons join. */
export const DEFAULT_GROUP_GAP_PX = 50;

/** The narrator never joins automatically, even on a SPEECH balloon. */
const NARRATOR_ID: RoleId = "narrator";

/** `bubbles.style` percent strings to page pixels; null when a field is missing. */
export function boxFromStyle(
  style: unknown,
  pageWidth: number,
  pageHeight: number,
): GroupBox | null {
  const s = (style ?? {}) as Record<string, unknown>;
  const f = (k: string) => {
    const v = s[k];
    return typeof v === "string" || typeof v === "number"
      ? Number.parseFloat(String(v)) / 100
      : Number.NaN;
  };
  const [left, top, width, height] = [
    f("left"),
    f("top"),
    f("width"),
    f("height"),
  ];
  if (![left, top, width, height].every(Number.isFinite)) return null;
  return {
    x: left * pageWidth,
    y: top * pageHeight,
    width: width * pageWidth,
    height: height * pageHeight,
  };
}

/** Edge-to-edge distance in pixels, unrounded; 0 when the boxes touch or overlap. */
export function gapBetween(a: GroupBox, b: GroupBox): number {
  const dx = Math.max(
    0,
    Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width),
  );
  const dy = Math.max(
    0,
    Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height),
  );
  return Math.hypot(dx, dy);
}

/** One page's balloon as the finder reads it. */
export type ScanBubble = {
  id: string;
  panelId: string | null;
  sortOrder: number;
  characterId: string | null;
  type: string;
  ignored: boolean;
  box: GroupBox | null;
};

/**
 * Finds the joined groups on one page. Ignored balloons are dropped and the
 * rest sorted by `sortOrder` (play order). A candidate pair is two neighbours
 * in that order in the same panel, both with a box, at most `gapPx` apart. A
 * candidate pair joins when both are SPEECH with the same speaker and that
 * speaker is not the narrator; joined pairs chain into one group.
 *
 * `groups`: every group of two or more member ids, in play order.
 * `disagreeing`: candidate pairs of two SPEECH balloons whose speakers are
 * both set and differ, for the review gate to flag.
 */
export function scanBalloonPairs(
  bubbles: ScanBubble[],
  gapPx = DEFAULT_GROUP_GAP_PX,
): { groups: string[][]; disagreeing: Array<[string, string]> } {
  const ordered = bubbles
    .filter((b) => !b.ignored)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const groups: string[][] = [];
  const disagreeing: Array<[string, string]> = [];
  let open: string[] | null = null;

  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1]!;
    const b = ordered[i]!;
    const candidate =
      a.panelId !== null &&
      a.panelId === b.panelId &&
      a.box !== null &&
      b.box !== null &&
      gapBetween(a.box, b.box) <= gapPx;
    const bothSpeech = a.type === "SPEECH" && b.type === "SPEECH";
    const joined =
      candidate &&
      bothSpeech &&
      a.characterId !== null &&
      a.characterId === b.characterId &&
      a.characterId !== NARRATOR_ID;

    if (joined) {
      if (open) {
        open.push(b.id);
      } else {
        open = [a.id, b.id];
        groups.push(open);
      }
    } else {
      open = null;
    }

    if (
      candidate &&
      bothSpeech &&
      a.characterId !== null &&
      b.characterId !== null &&
      a.characterId !== b.characterId
    ) {
      disagreeing.push([a.id, b.id]);
    }
  }

  return { groups, disagreeing };
}

/** A leading ellipsis, after any leading cue tags (`[tag] `), which group 1 keeps. */
const LEADING_ELLIPSIS = /^((?:\[[^\]]*\]\s*)*)(?:\.\.\.|…)\s*/;
const TRAILING_ELLIPSIS = /(?:\.\.\.|…)$/;

/**
 * Each member's text as it appears in the joined line: trimmed, and with its
 * leading ellipsis dropped when the text before it ends in one. Leading cue
 * tags stay: "[thoughtful] ...But" becomes "[thoughtful] But".
 */
function groupTextParts(texts: string[]): string[] {
  const parts: string[] = [];
  let joined = "";
  for (const text of texts) {
    let part = text.trim();
    if (TRAILING_ELLIPSIS.test(joined) && LEADING_ELLIPSIS.test(part)) {
      part = part.replace(LEADING_ELLIPSIS, "$1").trimEnd();
    }
    parts.push(part);
    if (part) joined = joined ? `${joined} ${part}` : part;
  }
  return parts;
}

/**
 * The group's one line from its members' texts, in play order: each trimmed,
 * joined with one space. "THAN..." then "...PRACTICE." reads
 * "THAN... PRACTICE.", not "THAN... ...PRACTICE.".
 */
export function joinGroupText(texts: string[]): string {
  return groupTextParts(texts)
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * Which of the group clip's words belong to each member: consecutive
 * half-open `[start, end)` ranges over the clip's word indexes, counting each
 * member's words as `joinGroupText` joins them and as the reader splits them
 * (`countSpokenWords`). Null when the counts do not add up to `totalWords`;
 * the reader then lights the lead only.
 */
export function memberWordRanges(
  memberTexts: string[],
  totalWords: number,
): Array<{ start: number; end: number }> | null {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const part of groupTextParts(memberTexts)) {
    const end = start + countSpokenWords(part);
    ranges.push({ start, end });
    start = end;
  }
  return start === totalWords ? ranges : null;
}

/** The group's lead: the member with the lowest `sortOrder` (the first listed on a tie). */
export function groupLeadId(
  members: Array<{ id: string; sortOrder: number }>,
): string {
  const [first, ...rest] = members;
  if (!first) throw new Error("groupLeadId: a group needs at least one member");
  // Ties on sortOrder break on the id, the same rule as the RPC's
  // `ORDER BY sort_order, id` (uuid order equals lowercase hex string order).
  let lead = first;
  for (const m of rest) {
    if (
      m.sortOrder < lead.sortOrder ||
      (m.sortOrder === lead.sortOrder && m.id < lead.id)
    ) {
      lead = m;
    }
  }
  return lead.id;
}

/**
 * Whether the group plays as one clip: every member stores the lead's
 * non-null audio path and the lead has word timings. Otherwise each balloon
 * plays its own clip, so a join made in the editor is safe before the group
 * is rendered.
 */
export function groupPlaysAsUnit(
  members: Array<{
    id: string;
    sortOrder: number;
    audioStoragePath: string | null;
    hasTimestamps: boolean;
  }>,
): boolean {
  if (members.length === 0) return false;
  const leadId = groupLeadId(members);
  const lead = members.find((m) => m.id === leadId)!;
  if (lead.audioStoragePath === null || !lead.hasTimestamps) return false;
  return members.every((m) => m.audioStoragePath === lead.audioStoragePath);
}
