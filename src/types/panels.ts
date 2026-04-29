/**
 * Panel direction data — shared between server loaders and client reader.
 */

export interface PanelBoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanelAudioTags {
  ambience: string[];
  sfx: string[];
  music_mood: string;
}

export interface PageDirectedPanel {
  id: string;
  panelId: string;
  pageNumber: number;
  sortOrder: number;
  boundingBox: PanelBoundingBox;
  cinematicDescription: string | null;
  effectTags: string[];
  audioTags: PanelAudioTags;
  primarySpeaker: string | null;
  estimatedDurationSeconds: number | null;
  isNewScene: boolean;
  source: "gemini" | "roboflow" | "manual";
  bubbleIds: string[];
}
