/**
 * Shared type definitions for comic-related data structures
 */

import type { BubbleType } from "~/lib/bubble-types";
import type { TextGeometry } from "~/types/text-geometry";

export interface Bubble {
  id: string;
  box_2d: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  ocr_text: string;
  type: BubbleType;
  speaker: string | null;
  /** The reader's caption: `characters.display_name` for the bubble's `character_id`, else `speaker`. */
  speakerName?: string | null;
  emotion: string;
  textWithCues?: string;
  aiReasoning?: string;
  audioStoragePath?: string;
  ignored?: boolean;
  /** Lettered word boxes (`bubbles.text_geometry`, #61); null when none were read. */
  textGeometry?: TextGeometry | null;
  /** The colour under the bubble's words, else its balloon fill (`bubbles.fill_color`, #575, #672), `#rrggbb`; null when not sampled. */
  fillColor?: string | null;
  /** Joined balloons (`bubbles.group_id`, #451): members of one group share it; null when the balloon stands alone. */
  groupId: string | null;
  /** Play order on the page (`bubbles.sort_order`); the reader picks a group's lead by it. */
  sortOrder: number;
  style?: {
    left: string;
    top: string;
    width: string;
    height: string;
  };
}

export interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface AudioTimestamps {
  alignment: CharacterAlignment | null;
  normalized_alignment: CharacterAlignment | null;
}
