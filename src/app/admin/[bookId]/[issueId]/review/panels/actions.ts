"use server";

import { revalidatePath } from "next/cache";
import { revalidateReaderPages } from "~/lib/revalidate-reader";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { requireAdmin } from "~/server/admin/require-admin";
import type { EffectPositions, PanelAudioTags } from "~/types/panels";

/**
 * The fields the panels page edits on an existing panel. Boxes, order, adds,
 * deletes and bubble assignment are the review editor's (#331).
 */
export interface PanelEdit {
  /** uuid of existing panel */
  id: string;
  cinematicDescription?: string | null;
  effectTags?: string[];
  effectPositions?: EffectPositions | null;
  audioTags?: PanelAudioTags;
  isNewScene?: boolean;
}

export interface PanelFixesPayload {
  bookId: string;
  issueId: string;
  edits: PanelEdit[];
}

export interface PanelFixesResult {
  ok: boolean;
  error?: string;
  updated: number;
}

export async function applyPanelFixes(
  payload: PanelFixesPayload,
): Promise<PanelFixesResult> {
  try {
    await requireAdmin();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      updated: 0,
    };
  }
  const result: PanelFixesResult = { ok: true, updated: 0 };

  for (const edit of payload.edits) {
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (edit.cinematicDescription !== undefined)
      update.cinematic_description = edit.cinematicDescription;
    if (edit.effectTags !== undefined) update.effect_tags = edit.effectTags;
    if (edit.effectPositions !== undefined)
      update.effect_positions = edit.effectPositions;
    if (edit.audioTags !== undefined) update.audio_tags = edit.audioTags;
    if (edit.isNewScene !== undefined) update.is_new_scene = edit.isNewScene;
    const { error } = await supabaseAdmin
      .from("panels")
      .update(update)
      .eq("id", edit.id)
      .eq("book_id", payload.bookId)
      .eq("issue_id", payload.issueId);
    if (error) return { ...result, ok: false, error: error.message };
    result.updated += 1;
  }

  revalidatePath(
    `/admin/${payload.bookId}/${payload.issueId}/review/panels`,
    "page",
  );
  await revalidateReaderPages(payload.bookId, payload.issueId);
  return result;
}
