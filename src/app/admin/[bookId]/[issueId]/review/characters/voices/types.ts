// What the voices stop's loader hands the browser.

import type {
  VoiceWorkAction,
  VoiceWorkSource,
  VoiceWorkState,
} from "~/lib/voice-requests";
import type { PageView, Rect } from "../types";

export interface VoiceRef {
  id: string;
  name: string;
}

/** A castlist row an archive would leave without a voice. */
export interface LeftWithout {
  bookId: string;
  issueId: string;
  character: string;
}

/** A voice the owner can name to archive, with what that archive leaves without a voice. */
export interface OutgoingChoice extends VoiceRef {
  leaves: LeftWithout[];
  /** Refusals the plan already knows; the rest are checked when Run is clicked. */
  refusals: string[];
}

export interface Candidate extends VoiceRef {
  labDefault: boolean;
  /** Signed URL of the source clip, for a listen before choosing. */
  clipUrl: string | null;
}

export interface SampleLine {
  bubbleId: string;
  page: number;
  text: string;
}

export interface ItemView {
  characterId: string;
  name: string;
  /** A `characters` row knows the id; without one nothing can be settled here. */
  known: boolean;
  source: VoiceWorkSource;
  action: VoiceWorkAction;
  state: VoiceWorkState;
  lines: number;
  /** Clone or restore: the archived voice that comes back. */
  target: VoiceRef | null;
  /** The character's own active voice, which a clone or design replaces. */
  replaces: VoiceRef | null;
  candidates: Candidate[];
  hasDescription: boolean;
  /** The character's active designed voices when the page loaded; Run measures a competing design against them (#458). */
  designedVoices: string[];
  /** Pending and not refused: takes a slot when it runs. */
  needsSlot: boolean;
  /** The plan's pick: a free slot, or the voice archived for this item. */
  outgoing:
    | { kind: "free slot" }
    | (OutgoingChoice & {
        kind: "archive";
        order: "add first" | "archive first";
      })
    | null;
  /** Voices he can name to archive instead: the plan's pick first, then the spares. */
  choices: OutgoingChoice[];
  refusals: string[];
  warnings: string[];
  /** Why the plan's default clone is not offered; the item then has no choice yet. */
  noDefault: string | null;
  /** A `carryOut` stopped uncertain: its phase, and the voice it archived. */
  attention: { phase: string; archived: VoiceRef | null } | null;
  /** The issue's castlist says "no audio this run" for this character. */
  noAudio: boolean;
  /** The voice `voiceFor` finds now; samples play in it. */
  voice: VoiceRef | null;
  /** Up to three of the character's lines in this issue. */
  samples: SampleLine[];
}

export interface SlotsView {
  used: number;
  limit: number;
  free: number;
  addEditUsed: number;
  addEditMax: number;
  headroom: number;
  adds: number;
  archives: number;
}

export interface Portrait {
  page: PageView;
  rect: Rect;
}

export interface VoicesData {
  bookId: string;
  issueId: string;
  bookName: string;
  issueName: string;
  /** Null when the plan could not be read; `planError` says why. */
  slots: SlotsView | null;
  planError: string | null;
  planRefusals: string[];
  items: ItemView[];
  /** Active voices: "use an active voice", no slot. */
  active: VoiceRef[];
  portraits: Record<string, Portrait>;
  /** Why Continue would be refused right now, or null when it would pass. */
  blocker: string | null;
}
