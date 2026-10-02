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
  /** `text_with_cues`: the text as the audio step reads it, emotion cues and all. */
  textWithCues: string | null;
  type: BubbleType;
  speaker: string | null;
  emotion: string;
  ignored: boolean;
  /** Shown, no audio: `bubbles.silent`. */
  silent: boolean;
  confidence: number | null;
  /** `audio_storage_path`: the current take in the `comic-audio` bucket, or null when it has none. */
  audioPath: string | null;
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
  /** Added in the browser with a new voice still to be made. */
  newVoice?: boolean;
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
}
