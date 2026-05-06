import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";

export interface ScenePanel {
  id: string;
  panelId: string;
  pageNumber: number;
  sortOrder: number;
  musicMood: string;
  isNewScene: boolean;
  sceneId: string | null;
}

export interface SceneRow {
  id: string;
  musicMood: string;
  label: string | null;
  startPanelId: string;
  endPanelId: string;
}

export interface SceneReviewData {
  bookId: string;
  issueId: string;
  panels: ScenePanel[];
  scenes: SceneRow[];
}

export async function getSceneReviewData(
  bookId: string,
  issueId: string,
): Promise<SceneReviewData> {
  const [panelRes, sceneRes] = await Promise.all([
    supabaseAdmin
      .from("panels")
      .select(
        "id, panel_id, page_number, sort_order, audio_tags, is_new_scene, scene_id",
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .order("page_number")
      .order("sort_order"),
    supabaseAdmin
      .from("music_scenes")
      .select("id, music_mood, label, start_panel_id, end_panel_id")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
  ]);

  type RawPanel = {
    id: string;
    panel_id: string;
    page_number: number;
    sort_order: number;
    audio_tags: { music_mood?: string } | null;
    is_new_scene: boolean;
    scene_id: string | null;
  };

  const panels: ScenePanel[] = ((panelRes.data ?? []) as RawPanel[]).map(
    (p) => ({
      id: p.id,
      panelId: p.panel_id,
      pageNumber: p.page_number,
      sortOrder: p.sort_order,
      musicMood: p.audio_tags?.music_mood ?? "transition_neutral",
      isNewScene: p.is_new_scene,
      sceneId: p.scene_id,
    }),
  );

  type RawScene = {
    id: string;
    music_mood: string;
    label: string | null;
    start_panel_id: string;
    end_panel_id: string;
  };

  const scenes: SceneRow[] = ((sceneRes.data ?? []) as RawScene[]).map((s) => ({
    id: s.id,
    musicMood: s.music_mood,
    label: s.label,
    startPanelId: s.start_panel_id,
    endPanelId: s.end_panel_id,
  }));

  return { bookId, issueId, panels, scenes };
}
