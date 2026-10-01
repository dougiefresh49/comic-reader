// THROWAWAY spike prototype for comic-reader #325, variant D (the reel).
// Siloed under src/app/admin/proto/d/ — never merged.

/** A rectangle in page fractions, the unit panels already use. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanelData {
  id: string;
  pageNumber: number;
  sortOrder: number;
  box: Rect;
}

export interface ClipData {
  id: string;
  pageNumber: number;
  /** uuid of the owning panel, null when the source row carried none. */
  panelId: string | null;
  text: string;
  speaker: string | null;
  emotion: string;
  type: string;
  ignored: boolean;
  /** Owner-marked as having no line to read aloud; not the same as ignored. */
  silent: boolean;
  /** null when the row had neither box_2d nor style. */
  box: Rect | null;
  /** source reading order inside its panel. */
  order: number;
  /** true for bubbles this prototype drew; they carry simulated fields. */
  isNew?: boolean;
}

export interface PageData {
  number: number;
  imageUrl: string;
  width: number;
  height: number;
}

export interface EditorData {
  bookId: string;
  bookName: string;
  issueId: string;
  issueName: string;
  pageCount: number;
  pages: PageData[];
  panels: PanelData[];
  clips: ClipData[];
  /** The closed cast: face-detection characters for this issue. */
  characters: string[];
}

/** The three roles every issue gets on top of its detected characters. */
export const GENERIC_ROLES: string[] = ["narrator", "off-panel", "crowd"];

export const BUBBLE_TYPES = [
  "speech",
  "narration",
  "caption",
  "sfx",
  "background",
] as const;

/** Muted, evenly-spaced hues. Speaker identity only, never decoration. */
export const SPEAKER_COLORS = [
  "#4f6d8a",
  "#7a5c8e",
  "#5f7d5a",
  "#8a6a4f",
  "#6f7a8a",
  "#8a5f5f",
  "#4f8a80",
  "#7d7a4f",
  "#5a6d7d",
  "#7d5f6d",
];

export function speakerColor(speaker: string | null): string {
  if (!speaker) return "#3f3f46";
  let h = 0;
  for (let i = 0; i < speaker.length; i++) {
    h = (h * 31 + speaker.charCodeAt(i)) >>> 0;
  }
  return SPEAKER_COLORS[h % SPEAKER_COLORS.length] ?? "#3f3f46";
}

/** Intersection over union, for duplicate detection and overlap ranking. */
export function iou(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

/** How much of `inner` sits inside `outer`, as a fraction of `inner`. */
export function containment(inner: Rect, outer: Rect): number {
  const area = inner.w * inner.h;
  if (area <= 0) return 0;
  const x1 = Math.max(inner.x, outer.x);
  const y1 = Math.max(inner.y, outer.y);
  const x2 = Math.min(inner.x + inner.w, outer.x + outer.w);
  const y2 = Math.min(inner.y + inner.h, outer.y + outer.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  return ((x2 - x1) * (y2 - y1)) / area;
}

/** Reading order inside a panel: top to bottom, then left to right. */
export function byTopLeft(a: Rect, b: Rect): number {
  const band = Math.min(a.h, b.h) * 0.4;
  if (Math.abs(a.y - b.y) <= band) return a.x - b.x;
  return a.y - b.y;
}

export function normText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface Problem {
  /** Why the clip is flagged. */
  kind: "no-speaker" | "off-cast" | "duplicate";
  label: string;
}

/**
 * The three things that stop a clip being ready: a spoken line with nobody
 * to say it, a speaker the issue's cast does not contain, and a second
 * detection of a bubble already on the page.
 */
export function problemFor(
  clip: ClipData,
  cast: string[],
  allClips: ClipData[],
): Problem | null {
  if (clip.ignored) return null;

  // Duplicate first. On the smoke pages a duplicate usually also has a
  // speaker that is off the list, and the duplicate is the one with a
  // one-action answer, so it is the flag the owner wants first.
  if (clip.box && clip.text.trim()) {
    for (const other of allClips) {
      if (other.id === clip.id || other.ignored) continue;
      if (!other.box || !other.text.trim()) continue;
      if (normText(other.text) !== normText(clip.text)) continue;
      if (
        iou(clip.box, other.box) > 0.5 ||
        containment(clip.box, other.box) > 0.8
      ) {
        return { kind: "duplicate", label: "duplicate detection" };
      }
    }
  }

  if (clip.type === "speech" && !clip.speaker && !clip.silent) {
    return { kind: "no-speaker", label: "no speaker" };
  }
  if (
    clip.speaker &&
    !cast.includes(clip.speaker) &&
    !GENERIC_ROLES.includes(clip.speaker)
  ) {
    return { kind: "off-cast", label: "speaker off the list" };
  }
  return null;
}
