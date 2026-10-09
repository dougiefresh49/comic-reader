// What the review editor's loader hands the browser. Every rect is in page fractions (0..1).
import type { BubbleType } from "~/lib/bubble-types";

export type { BubbleType };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SrcPage {
  number: number;
  width: number;
  height: number;
  imageUrl: string;
  /** `pages.reviewed_at`: when the owner approved the page, or null. */
  reviewedAt: string | null;
  /** `pages.spread_with_next`: this page and the next are one spread (#723). */
  spreadWithNext: boolean;
}

export interface SrcPanel {
  id: string;
  page: number;
  rect: Rect;
  /** Bubble ids linked by `bubbles.panel_id`, in play order. */
  bubbleIds: string[];
}

export interface SrcBubble {
  id: string;
  page: number;
  rect: Rect;
  text: string;
  /** `text_with_cues`: the text as the audio step reads it, emotion cues and all. */
  textWithCues: string | null;
  type: BubbleType;
  /** `bubbles.character_id`: who speaks. Null is unassigned, whatever `speaker` says. */
  characterId: string | null;
  /** `bubbles.speaker`: the label, shown while `characterId` is null. */
  speaker: string | null;
  emotion: string;
  ignored: boolean;
  /** Shown, no audio: `bubbles.silent`. */
  silent: boolean;
  /** The owner said an overlap is not a duplicate: `bubbles.kept`. */
  kept: boolean;
  confidence: number | null;
  /** `audio_storage_path`: the current take in the `comic-audio` bucket, or null when it has none. */
  audioPath: string | null;
  /**
   * `bubbles.group_id` (#451): shared by two or more rows = joined balloons;
   * held by one row = reviewed, stands alone; null = not reviewed yet.
   */
  groupId: string | null;
}

export interface Face {
  id: string;
  characterId: string | null;
  page: number;
  rect: Rect;
  confidence: number;
}

export interface Portrait {
  page: number;
  rect: Rect;
}

/** An active `voices` row. The id picks the voice; the name is only shown. */
export interface VoiceOption {
  id: string;
  name: string;
}

export interface CastMember {
  id: string;
  name: string;
  aliases: string[];
  kind: "character" | "role";
  /** Index into the speaker tints. */
  tint: number;
  /** The active voice it uses today, or null when it has none. */
  voice: VoiceOption | null;
  portrait: Portrait | null;
}

/** A `characters` row, in the cast or not, for matching a typed name. */
export interface KnownCharacter {
  id: string;
  name: string;
  aliases: string[];
  /** Its active voice, or null. */
  voice: VoiceOption | null;
}

export interface EditorData {
  bookId: string;
  issueId: string;
  bookName: string;
  issueName: string;
  pages: SrcPage[];
  panels: SrcPanel[];
  bubbles: SrcBubble[];
  faces: Face[];
  cast: CastMember[];
  known: KnownCharacter[];
  voices: VoiceOption[];
  slotsUsed: number;
  slotsTotal: number;
  /** The issue's run is paused at the pages gate (`review-pages`), so "Approve issue" shows. */
  atPagesGate: boolean;
}
