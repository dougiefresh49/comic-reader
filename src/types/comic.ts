/**
 * Shared type definitions for comic-related data structures
 */

import type { BubbleType } from "~/lib/bubble-types";

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
