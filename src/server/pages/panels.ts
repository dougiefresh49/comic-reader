import "server-only";
import { supabase } from "~/lib/supabase";

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
  id: string; // panels.id (UUID)
  panelId: string; // stable within issue, e.g. "p03-01"
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
  /** UUIDs of bubbles assigned to this panel via bubbles.panel_id FK */
  bubbleIds: string[];
}

interface PanelRow {
  id: string;
  panel_id: string;
  page_number: number;
  sort_order: number;
  bounding_box: PanelBoundingBox;
  cinematic_description: string | null;
  effect_tags: string[];
  audio_tags: PanelAudioTags | null;
  primary_speaker: string | null;
  estimated_duration_seconds: number | null;
  is_new_scene: boolean;
  source: string;
  bubbles: Array<{ id: string; sort_order: number }> | null;
}

function rowToPanel(row: PanelRow): PageDirectedPanel {
  const bubbles = (row.bubbles ?? [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
  return {
    id: row.id,
    panelId: row.panel_id,
    pageNumber: row.page_number,
    sortOrder: row.sort_order,
    boundingBox: row.bounding_box,
    cinematicDescription: row.cinematic_description,
    effectTags: row.effect_tags ?? [],
    audioTags: row.audio_tags ?? {
      ambience: [],
      sfx: [],
      music_mood: "transition_neutral",
    },
    primarySpeaker: row.primary_speaker,
    estimatedDurationSeconds: row.estimated_duration_seconds,
    isNewScene: row.is_new_scene,
    source:
      row.source === "roboflow" || row.source === "manual"
        ? row.source
        : "gemini",
    bubbleIds: bubbles.map((b) => b.id),
  };
}

/**
 * Read panels (with their bubble UUIDs joined via FK) for a single page.
 * Used by the motion-comic reader to drive the panel-by-panel view.
 */
export async function getPanelsForPage(
  bookId: string,
  issueId: string,
  pageNumber: number,
): Promise<PageDirectedPanel[]> {
  const { data, error } = await supabase
    .from("panels")
    .select(
      "id, panel_id, page_number, sort_order, bounding_box, cinematic_description, effect_tags, audio_tags, primary_speaker, estimated_duration_seconds, is_new_scene, source, bubbles(id, sort_order)",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNumber)
    .order("sort_order");
  if (error) {
    console.error("getPanelsForPage:", error);
    return [];
  }
  return ((data ?? []) as unknown as PanelRow[]).map(rowToPanel);
}

/**
 * Read all panels for an issue at once (for the panel-editing review UI).
 */
export async function getPanelsForIssue(
  bookId: string,
  issueId: string,
): Promise<PageDirectedPanel[]> {
  const { data, error } = await supabase
    .from("panels")
    .select(
      "id, panel_id, page_number, sort_order, bounding_box, cinematic_description, effect_tags, audio_tags, primary_speaker, estimated_duration_seconds, is_new_scene, source, bubbles(id, sort_order)",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .order("page_number")
    .order("sort_order");
  if (error) {
    console.error("getPanelsForIssue:", error);
    return [];
  }
  return ((data ?? []) as unknown as PanelRow[]).map(rowToPanel);
}
