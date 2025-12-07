/**
 * Shared type definitions for comic-related data structures
 */

export interface Bubble {
  id: string;
  box_2d: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    index?: number;
  };
  ocr_text: string;
  type: "SPEECH" | "NARRATION" | "CAPTION" | "SFX" | "BACKGROUND";
  speaker: string | null;
  emotion: string;
  textWithCues?: string;
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

