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
  /** The `voices` row id, when the castlist or the starting voice names one. */
  uuid: string | null;
}

/** A voice-lab clone on file for the character: an archived `voices` row with a source clip, linked to no castlist row of this book. */
export interface LabCandidate {
  id: string;
  name: string;
  labDefault: boolean;
  /** A signed URL to the source clip, or null when signing failed (no play button). */
  clipUrl: string | null;
}

/** A `casting_tasks` request for this character in this issue with `status = 'pending'`. */
export interface PendingVoiceRequest {
  action: "clone" | "design";
  /** The clone's voice display name; null for a design. */
  targetName: string | null;
}

/** A `voices` row with `status = 'active'`, for "Another active voice". */
export interface ActiveVoice {
  id: string;
  name: string;
}

export type CardGroup = "here" | "before" | "role";

export interface CharacterCard {
  /** The `characters.id`, or the castlist text's slug when no row exists. */
  id: string;
  name: string;
  group: CardGroup;
  sources: CastSource[];
  wikiNames: string[];
  /** The issue's castlist says no (`in_issue` false on every row). */
  removed: boolean;
  faces: FaceView[];
  looseExemplars: LooseExemplar[];
  voice: VoiceView | null;
  /** Lab default first, then by name. Empty for a card with no Change control. */
  labCandidates: LabCandidate[];
  voiceRequest: PendingVoiceRequest | null;
}

export interface UnknownGroupView {
  key: string;
  suggestedNames: string[];
  faces: FaceView[];
  looseExemplars: LooseExemplar[];
}

/** A name no `characters` row knows: from the wiki, or a castlist text of this book. Never blocks Approve. */
export interface Suggestion {
  name: string;
  qualifier: string;
  source: "wiki" | "cast before";
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
  suggestions: Suggestion[];
  cards: CharacterCard[];
  known: KnownCharacter[];
  /** Every active voice, by display name. */
  activeVoices: ActiveVoice[];
  /** Why Approve would be refused right now, or null when it would pass. */
  blocker: string | null;
}
