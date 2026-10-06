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

  // save_music_scenes clears, deletes, inserts and assigns in one transaction.
  const { data: inserted, error } = (await supabaseAdmin.rpc(
    "save_music_scenes",
    {
      p_book_id: bookId,
      p_issue_id: issueId,
      p_scenes: scenes.map((scene) => ({
        music_mood: scene.musicMood,
        label: scene.label,
        panel_ids: scene.panelIds,
      })),
    },
  )) as { data: number; error: { message: string } | null };
  if (error) return { ok: false, error: error.message, sceneCount: 0 };

  revalidatePath(`/admin/${bookId}/${issueId}/review/scenes`, "page");
  revalidatePath(`/admin/${bookId}/${issueId}/review/panels`, "page");
  await revalidateReaderPages(bookId, issueId);

  return { ok: true, sceneCount: inserted };
}
