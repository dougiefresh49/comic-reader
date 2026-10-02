// What the characters stop's loader hands the browser. Every rect is in page fractions (0..1).

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

export interface VoiceView {
  name: string;
  /** The character whose castlist row holds the voice, when it is borrowed. */
  borrowedFrom: string | null;
}

export type CardGroup = "here" | "before" | "role";

export interface CharacterCard {
  /** The `characters.id`, or the castlist text's slug when no row exists. */
  id: string;
  name: string;
  /** False for a castlist text that matches no `characters` row. */
  hasRow: boolean;
  group: CardGroup;
  sources: CastSource[];
  wikiNames: string[];
  /** The issue's castlist says no (`in_issue` false on every row). */
  removed: boolean;
  faces: FaceView[];
  looseExemplars: LooseExemplar[];
  voice: VoiceView | null;
}

export interface UnknownGroupView {
  key: string;
  suggestedNames: string[];
  faces: FaceView[];
  looseExemplars: LooseExemplar[];
}

export interface WikiSuggestion {
  name: string;
  qualifier: string;
}

/** Every `characters` row, for naming and adding. */
export interface KnownCharacter {
  id: string;
  name: string;
  aliases: string[];
}

export interface CharactersData {
  bookId: string;
  issueId: string;
  bookName: string;
  issueName: string;
  franchise: string | null;
  pages: PageView[];
  unknown: UnknownGroupView[];
  suggestions: WikiSuggestion[];
  cards: CharacterCard[];
  known: KnownCharacter[];
  /** Why Approve would be refused right now, or null when it would pass. */
  blocker: string | null;
}
