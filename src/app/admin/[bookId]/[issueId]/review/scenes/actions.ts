"use server";

import { revalidatePath } from "next/cache";
import { revalidateReaderPages } from "~/lib/revalidate-reader";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { requireAdmin } from "~/server/admin/require-admin";

export interface SceneSaveEntry {
  musicMood: string;
  label: string | null;
  panelIds: string[];
}

export interface SceneSaveResult {
  ok: boolean;
  error?: string;
  sceneCount: number;
}

export async function saveScenes(
  bookId: string,
  issueId: string,
  scenes: SceneSaveEntry[],
): Promise<SceneSaveResult> {
  try {
    await requireAdmin();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      sceneCount: 0,
    };
  }

  // 1. Clear existing scene assignments
  const { error: clearErr } = await supabaseAdmin
    .from("panels")
    .update({ scene_id: null })
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .not("scene_id", "is", null);

  if (clearErr) return { ok: false, error: clearErr.message, sceneCount: 0 };

  // 2. Delete existing scenes
  const { error: delErr } = await supabaseAdmin
    .from("music_scenes")
    .delete()
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  if (delErr) return { ok: false, error: delErr.message, sceneCount: 0 };

  // 3. Insert new scenes + assign panels
  let inserted = 0;
  for (const scene of scenes) {
    if (scene.panelIds.length === 0) continue;

    const startPanelId = scene.panelIds[0]!;
    const endPanelId = scene.panelIds[scene.panelIds.length - 1]!;

    const { data: row, error: insErr } = await supabaseAdmin
      .from("music_scenes")
      .insert({
        book_id: bookId,
        issue_id: issueId,
        music_mood: scene.musicMood,
        label: scene.label,
        start_panel_id: startPanelId,
        end_panel_id: endPanelId,
      })
      .select("id")
      .single();

    if (insErr)
      return { ok: false, error: insErr.message, sceneCount: inserted };

    const sceneId = (row as { id: string }).id;
    const { error: assignErr } = await supabaseAdmin
      .from("panels")
      .update({ scene_id: sceneId })
      .in("id", scene.panelIds);

    if (assignErr)
      return { ok: false, error: assignErr.message, sceneCount: inserted };

    inserted++;
  }

  revalidatePath(`/admin/${bookId}/${issueId}/review/scenes`, "page");
  revalidatePath(`/admin/${bookId}/${issueId}/review/panels`, "page");
  await revalidateReaderPages(bookId, issueId);

  return { ok: true, sceneCount: inserted };
}
