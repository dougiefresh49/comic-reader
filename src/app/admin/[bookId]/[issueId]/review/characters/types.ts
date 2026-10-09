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
  /** A per-row preview override; left unset, the Voice tab asks `voicePreview` on the first Play. */
  previewUrl?: string | null;
}

/**
 * One entry of a card's "Its voices" list (#458): a `voices` row of the
 * character, or an appearance (`appearances` row) that no voice holds yet.
 */
export type VoicePick =
  | {
      kind: "voice";
      /** The `voices` row id. */
      id: string;
      name: string;
      status: "active" | "archived" | "needs_clip";
      /** A castlist row of this book references it. An archived one is then cast for this issue, and the voices stop restores it; it is not a new clone (#350). */
      inBook: boolean;
      /** "Title (year)" of the work it is cloned from; null for a designed voice. */
      work: string | null;
      /** The voice's appearance; null for a designed voice. */
      appearanceId: string | null;
      startingPick: boolean;
      /** A signed URL to an archived entry's source clip; null otherwise, or when signing failed (no play button). */
      clipUrl: string | null;
    }
  | {
      kind: "appearance";
      /** The `appearances` row id. */
      id: string;
      /** "Title (year)" of the work. */
      work: string;
      voiceActor: string | null;
    };

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
  /** A per-row preview override; left unset, the Voice tab asks `voicePreview` on the first Play. */
  previewUrl?: string | null;
}

export type CardGroup = "here" | "before" | "role";

export interface CharacterCard {
  /** The `characters.id`, or the castlist text's slug when no row exists. */
  id: string;
  name: string;
  group: CardGroup;
  sources: CastSource[];
  wikiNames: string[];
  /** The issue's castlist row says no (`in_issue` false). */
  removed: boolean;
  faces: FaceView[];
  looseExemplars: LooseExemplar[];
  /** The issue's castlist row has `no_audio`: the card shows it silent, with no voice (#410). */
  noAudio: boolean;
  voice: VoiceView | null;
  /** Active, archived, then needs_clip voices, then appearances no voice holds; starting picks first, then by name. Empty for a card with no Change control. */
  voicePicks: VoicePick[];
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
  /** The `franchises.id` a character created here takes: the book's lowest-position one, or null. */
  franchiseId: string | null;
  pages: PageView[];
  unknown: UnknownGroupView[];
  suggestions: Suggestion[];
  /** Wiki names dismissed for this issue (`issues.dismissed_wiki_names`), hidden from Needs a name until restored. */
  dismissed: Suggestion[];
  cards: CharacterCard[];
  known: KnownCharacter[];
  /** Every active voice, by display name. */
  activeVoices: ActiveVoice[];
  /** Why Approve would be refused right now, or null when it would pass. */
  blocker: string | null;
}
