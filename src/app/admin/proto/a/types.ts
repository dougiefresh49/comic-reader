// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// Shapes shared by the three prototype screens. Every rect is in page fractions (0..1).

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
  /** Bubble ids linked by `bubbles.panel_id`, in play order. Empty on the smoke issue. */
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
  /** Display name of the voice it uses today, or null when it has none. */
  voice: string | null;
  faceCount: number;
  pages: number[];
  portrait: Portrait | null;
}

export interface VoiceOption {
  id: string;
  name: string;
}

export interface ProtoData {
  bookId: string;
  issueId: string;
  bookName: string;
  issueName: string;
  run: {
    status: string;
    step: string | null;
    paused: boolean;
    pausedAt: string | null;
  };
  pages: SrcPage[];
  panels: SrcPanel[];
  bubbles: SrcBubble[];
  faces: Face[];
  cast: CastMember[];
  voices: VoiceOption[];
  slotsUsed: number;
  slotsTotal: number;
}
