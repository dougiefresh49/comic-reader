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

/** A polygon ring as a flat list of {x,y} points in panel-local 0..1 coords. */
export type PanelLocalPolygon = Array<{ x: number; y: number }>;

/**
 * Foreground masks per panel, used by the layered renderer to put particle
 * effects between the page background and characters/bubbles.
 *
 * - characters: union of comic character / person / face / head polygons
 * - bubbles:    speech bubble polygons
 *
 * Polygon coordinates are panel-local 0..1 (fraction of panel bbox).
 */
export interface PanelForegroundPolygons {
  characters: PanelLocalPolygon[];
  bubbles: PanelLocalPolygon[];
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
  /** Null until extract-foreground-masks + backfill have run for this panel. */
  foregroundPolygons: PanelForegroundPolygons | null;
}
