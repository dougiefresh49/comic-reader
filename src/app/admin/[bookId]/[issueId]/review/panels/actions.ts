"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";
import type {
  EffectPositions,
  PanelBoundingBox,
  PanelAudioTags,
} from "~/types/panels";

type AudioTags = PanelAudioTags;

export interface PanelEdit {
  /** uuid of existing panel */
  id: string;
  boundingBox?: PanelBoundingBox;
  cinematicDescription?: string | null;
  effectTags?: string[];
  effectPositions?: EffectPositions | null;
  audioTags?: AudioTags;
  primarySpeaker?: string | null;
  isNewScene?: boolean;
  sortOrder?: number;
  source?: string;
}

export interface PanelInsert {
  /** client-generated tempId so the response can map back to a real uuid */
  tempId: string;
  pageNumber: number;
  panelId: string; // "pNN-MM"
  sortOrder: number;
  boundingBox: PanelBoundingBox;
  cinematicDescription?: string | null;
  effectTags?: string[];
  audioTags?: AudioTags;
  primarySpeaker?: string | null;
  isNewScene?: boolean;
}

export interface BubbleReassign {
  /** uuid of bubble */
  bubbleId: string;
  /** uuid of panel, or null to unassign */
  panelId: string | null;
}

export interface PanelFixesPayload {
  bookId: string;
  issueId: string;
  edits: PanelEdit[];
  inserts: PanelInsert[];
  /** uuids of panels to delete */
  deletes: string[];
  reassigns: BubbleReassign[];
}

export interface PanelFixesResult {
  ok: boolean;
  error?: string;
  updated: number;
  inserted: number;
  deleted: number;
  reassigned: number;
  /** tempId → uuid map for new panels */
  insertedIds: Record<string, string>;
}

const EMPTY_RESULT: PanelFixesResult = {
  ok: true,
  updated: 0,
  inserted: 0,
  deleted: 0,
  reassigned: 0,
  insertedIds: {},
};

export async function applyPanelFixes(
  payload: PanelFixesPayload,
): Promise<PanelFixesResult> {
  const result: PanelFixesResult = { ...EMPTY_RESULT, insertedIds: {} };

  // 1. Inserts first — bubbles may want to reassign to new panels in the same batch.
  if (payload.inserts.length > 0) {
    const rows = payload.inserts.map((p) => ({
      book_id: payload.bookId,
      issue_id: payload.issueId,
      page_number: p.pageNumber,
      panel_id: p.panelId,
      sort_order: p.sortOrder,
      bounding_box: p.boundingBox,
      cinematic_description: p.cinematicDescription ?? null,
      effect_tags: p.effectTags ?? [],
      audio_tags: p.audioTags ?? {
        ambience: [],
        sfx: [],
        music_mood: "transition_neutral",
      },
      primary_speaker: p.primarySpeaker ?? null,
      is_new_scene: p.isNewScene ?? false,
      source: "manual",
    }));
    const { data, error } = await supabaseAdmin
      .from("panels")
      .insert(rows)
      .select("id, panel_id, page_number");
    if (error) return { ...result, ok: false, error: error.message };
    for (const r of data ?? []) {
      const inserted = payload.inserts.find(
        (p) => p.panelId === r.panel_id && p.pageNumber === r.page_number,
      );
      if (inserted) result.insertedIds[inserted.tempId] = r.id as string;
    }
    result.inserted = (data ?? []).length;
  }

  // 2. Edits
  for (const edit of payload.edits) {
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (edit.boundingBox !== undefined) update.bounding_box = edit.boundingBox;
    if (edit.cinematicDescription !== undefined)
      update.cinematic_description = edit.cinematicDescription;
    if (edit.effectTags !== undefined) update.effect_tags = edit.effectTags;
    if (edit.effectPositions !== undefined)
      update.effect_positions = edit.effectPositions;
    if (edit.audioTags !== undefined) update.audio_tags = edit.audioTags;
    if (edit.primarySpeaker !== undefined)
      update.primary_speaker = edit.primarySpeaker;
    if (edit.isNewScene !== undefined) update.is_new_scene = edit.isNewScene;
    if (edit.sortOrder !== undefined) update.sort_order = edit.sortOrder;
    if (edit.source !== undefined) update.source = edit.source;
    const { error } = await supabaseAdmin
      .from("panels")
      .update(update)
      .eq("id", edit.id);
    if (error) return { ...result, ok: false, error: error.message };
    result.updated += 1;
  }

  // 3. Bubble reassignments
  for (const r of payload.reassigns) {
    const { error } = await supabaseAdmin
      .from("bubbles")
      .update({
        panel_id: r.panelId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", r.bubbleId);
    if (error) return { ...result, ok: false, error: error.message };
    result.reassigned += 1;
  }

  // 4. Deletes (FK ON DELETE SET NULL on bubbles.panel_id)
  if (payload.deletes.length > 0) {
    const { error } = await supabaseAdmin
      .from("panels")
      .delete()
      .in("id", payload.deletes);
    if (error) return { ...result, ok: false, error: error.message };
    result.deleted = payload.deletes.length;
  }

  revalidatePath(
    `/admin/${payload.bookId}/${payload.issueId}/review/panels`,
    "page",
  );
  revalidatePath(`/book/${payload.bookId}/${payload.issueId}`, "page");
  return result;
}
