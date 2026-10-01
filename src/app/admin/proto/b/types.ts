// THROWAWAY spike for issue #325 (review editor variant B, the triage queue). Never merges.

export type BubbleType =
  | "SPEECH"
  | "NARRATION"
  | "CAPTION"
  | "SFX"
  | "BACKGROUND";

export const BUBBLE_TYPES: BubbleType[] = [
  "SPEECH",
  "NARRATION",
  "CAPTION",
  "SFX",
  "BACKGROUND",
];

/** Types a voice reads aloud. SFX and BACKGROUND are never spoken. */
export const SPOKEN_TYPES = new Set<BubbleType>([
  "SPEECH",
  "NARRATION",
  "CAPTION",
]);

/** A rectangle in page fractions, 0..1 on both axes. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ProtoPage {
  number: number;
  width: number;
  height: number;
  imageUrl: string;
}

export interface ProtoPanel {
  id: string;
  page: number;
  order: number;
  box: Box;
  /** Character ids whose faces were detected in this panel, most hits first. */
  faces: string[];
}

export interface ProtoBubble {
  id: string;
  page: number;
  text: string;
  type: BubbleType;
  speaker: string | null;
  emotion: string;
  ignored: boolean;
  silent: boolean;
  box: Box;
  confidence: number | null;
  /** Stored panel link. Null means "compute by overlap". */
  panelId: string | null;
  isNew?: boolean;
}

export interface CastMember {
  id: string;
  name: string;
  aliases: string[];
  kind: "cast" | "generic" | "added";
}

export interface ProtoData {
  bookId: string;
  issueId: string;
  issueName: string;
  pages: ProtoPage[];
  panels: ProtoPanel[];
  bubbles: ProtoBubble[];
  /** Bubble ids per page in stored sort order. */
  order: Record<number, string[]>;
  cast: CastMember[];
  loadNote: string | null;
}

export type Decision = "accepted" | "silent" | "ignored" | "duplicate";

export interface Offer {
  text: string;
  speaker: string;
  emotion: string;
}

export interface EditState {
  bubbles: Record<string, ProtoBubble>;
  panels: Record<string, ProtoPanel>;
  order: Record<number, string[]>;
  decided: Record<string, Decision>;
  bulkAccepted: Record<string, true>;
  approvedPages: number[];
  issueApproved: boolean;
  addedCast: CastMember[];
}

export type SignalKey =
  | "no-speaker"
  | "off-list"
  | "duplicate"
  | "merged"
  | "no-panel"
  | "not-in-panel"
  | "low-confidence"
  | "new";

export interface Signal {
  key: SignalKey;
  detail: string;
  /** Twin bubble ids for duplicates, part ids for merged boxes. */
  related?: string[];
  /** A cast id the signal suggests, e.g. an alias match. */
  suggest?: string;
}
