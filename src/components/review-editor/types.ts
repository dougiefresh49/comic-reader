// What the review editor's loader hands the browser. Every rect is in page fractions (0..1).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type BubbleType =
  | "SPEECH"
  | "NARRATION"
  | "CAPTION"
  | "SFX"
  | "BACKGROUND";

export interface SrcPage {
  number: number;
  width: number;
  height: number;
  imageUrl: string;
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
  type: BubbleType;
  speaker: string | null;
  emotion: string;
  ignored: boolean;
  confidence: number | null;
}

export interface Face {
  id: string;
  characterId: string | null;
  page: number;
  panelId: string;
  rect: Rect;
  confidence: number;
}

export interface Portrait {
  page: number;
  rect: Rect;
}

export interface CastMember {
  id: string;
  name: string;
  aliases: string[];
  kind: "character" | "role";
  /** Index into the speaker tints. */
  tint: number;
  /** Display name of the active voice it uses today, or null when it has none. */
  voice: string | null;
  faceCount: number;
  pages: number[];
  portrait: Portrait | null;
}

/** A `characters` row, in the cast or not, for matching a typed name. */
export interface KnownCharacter {
  id: string;
  name: string;
  aliases: string[];
  /** Display name of its active voice, or null. */
  voice: string | null;
}

export interface VoiceOption {
  id: string;
  name: string;
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
}
