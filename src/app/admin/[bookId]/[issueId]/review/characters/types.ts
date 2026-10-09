// What the casting page's loader hands the browser. Every rect is in page fractions (0..1).

import type { CastSource } from "~/lib/cast";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageView {
  number: number;
  width: number;
  height: number;
  imageUrl: string;
}

/** One `panel_character_detections` row, with its exemplar when one points at it. */
export interface FaceView {
  id: string;
  page: number;
  rect: Rect;
  confidence: number;
  verified: boolean;
  exemplar: { id: string; confirmed: boolean; cropUrl: string } | null;
}

/** An exemplar with no `detection_id`: shown beside the faces, never acted on by face. */
export interface LooseExemplar {
  id: string;
  page: number;
  confirmed: boolean;
  cropUrl: string;
}

/** The voice the render chain finds for a character in this issue now. */
export interface VoiceView {
  name: string;
  /** The character whose castlist row holds the voice, when it is borrowed. */
  borrowedFrom: string | null;
  /** The `voices` row id. */
  uuid: string | null;
}

/** One of a character's lines in this issue, with its rendered audio when there is some. */
export interface SampleLine {
  bubbleId: string;
  page: number;
  text: string;
  audioUrl: string | null;
}

export type CardGroup = "here" | "before" | "role";

export interface CharacterCard {
  /** The `characters.id`, or the castlist text's slug when no row exists. */
  id: string;
  name: string;
  group: CardGroup;
  sources: CastSource[];
  wikiNames: string[];
  /** A `characters` row knows the id. */
  known: boolean;
  /** The issue's castlist row says no (`in_issue` false). */
  removed: boolean;
  faces: FaceView[];
  looseExemplars: LooseExemplar[];
  /** The issue's castlist row has `no_audio`. */
  noAudio: boolean;
  voice: VoiceView | null;
  /** Speaking bubbles in this issue. */
  lines: number;
  /** "5–23", the pages its lines (or faces) are on; null for none. */
  pages: string | null;
  /** Its first lines, up to three. */
  samples: SampleLine[];
}

/** A `voices` row, as the Voice tab, the slot strip and Review name it. */
export interface VoiceOption {
  id: string;
  name: string;
  status: "active" | "archived" | "needs_clip" | "library";
  characterId: string | null;
  kind: "clone" | "designed" | "library";
  /** The voice-lab's default pick for the character (`starting_pick`). */
  labPick: boolean;
  /** One of the owner's v2 voices: never swapped out, never cast for another character. */
  protected: boolean;
}

export interface UnknownGroupView {
  key: string;
  suggestedNames: string[];
  faces: FaceView[];
  looseExemplars: LooseExemplar[];
}

/** Every `characters` row, for naming and adding. */
export interface KnownCharacter {
  id: string;
  name: string;
  aliases: string[];
}

/** Which pipeline pause the page is answering, and why its button would be refused now. */
export type PauseView =
  | { step: "review-clusters"; blocker: string | null }
  | { step: "casting"; blocker: string | null };

export interface CharactersData {
  bookId: string;
  issueId: string;
  bookName: string;
  issueName: string;
  /** The `franchises.id` a character created here takes: the book's lowest-position one, or null. */
  franchiseId: string | null;
  pages: PageView[];
  unknown: UnknownGroupView[];
  cards: CharacterCard[];
  /** The book's cast from other issues that has no card here, as cards, for + Add. */
  earlierCast: CharacterCard[];
  /** Wiki names no `characters` row knows, for + Add as new names. */
  wikiNames: string[];
  known: KnownCharacter[];
  /** Every `voices` row except `needs_clip`. */
  voices: VoiceOption[];
  /** The paused run's step, or null when no run is paused here. */
  pause: PauseView | null;
}
