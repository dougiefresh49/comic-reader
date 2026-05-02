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
export type EffectAnchor =
  | "center"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "top-center"
  | "bottom-center"
  | "left-center"
  | "right-center";

export interface EffectPosition {
  anchor?: EffectAnchor;
  /** Sub-region within the panel bbox, 0..1 fractions of panel. */
  bbox?: [number, number, number, number];
}

/** Position hints for effect tags, keyed by tag name. */
export type EffectPositions = Record<string, EffectPosition>;

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
  /** Per-effect placement hints from Gemini panel-director. */
  effectPositions: EffectPositions | null;
  /** Null until extract-foreground-masks + backfill have run for this panel. */
  foregroundPolygons: PanelForegroundPolygons | null;
  /** Null until consolidate-music-scenes has run. */
  sceneId: string | null;
}
