"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";

type Result = { ok: true } | { ok: false; error: string };

function revalidate(bookId: string, issueId: string) {
  revalidatePath(`/admin/${bookId}/${issueId}/review/clusters`, "page");
}

export async function confirmCluster(args: {
  bookId: string;
  issueId: string;
  detectionIds: string[];
  exemplarIds: string[];
}): Promise<Result> {
  if (args.detectionIds.length > 0) {
    const { error } = await supabaseAdmin
      .from("panel_character_detections")
      .update({ human_verified: true })
      .in("id", args.detectionIds);
    if (error) return { ok: false, error: error.message };
  }

  if (args.exemplarIds.length > 0) {
    const { error } = await supabaseAdmin
      .from("character_face_exemplars")
      .update({ is_confirmed: true })
      .in("id", args.exemplarIds);
    if (error) return { ok: false, error: error.message };
  }

  revalidate(args.bookId, args.issueId);
  return { ok: true };
}

export async function rejectDetections(args: {
  bookId: string;
  issueId: string;
  detectionIds: string[];
  exemplarIds: string[];
}): Promise<Result> {
  if (args.detectionIds.length > 0) {
    const { error } = await supabaseAdmin
      .from("panel_character_detections")
      .delete()
      .in("id", args.detectionIds);
    if (error) return { ok: false, error: error.message };
  }

  if (args.exemplarIds.length > 0) {
    const { error } = await supabaseAdmin
      .from("character_face_exemplars")
      .delete()
      .in("id", args.exemplarIds);
    if (error) return { ok: false, error: error.message };
  }

  revalidate(args.bookId, args.issueId);
  return { ok: true };
}

export async function reassignDetections(args: {
  bookId: string;
  issueId: string;
  detectionIds: string[];
  exemplarIds: string[];
  targetCharacterId: string;
}): Promise<Result> {
  if (args.detectionIds.length > 0) {
    const { error } = await supabaseAdmin
      .from("panel_character_detections")
      .update({ character_id: args.targetCharacterId, suggested_name: null })
      .in("id", args.detectionIds);
    if (error) return { ok: false, error: error.message };
  }

  if (args.exemplarIds.length > 0) {
    const { error } = await supabaseAdmin
      .from("character_face_exemplars")
      .update({ character_id: args.targetCharacterId, suggested_name: null })
      .in("id", args.exemplarIds);
    if (error) return { ok: false, error: error.message };
  }

  revalidate(args.bookId, args.issueId);
  return { ok: true };
}

export async function renameCluster(args: {
  bookId: string;
  issueId: string;
  detectionIds: string[];
  exemplarIds: string[];
  newCharacterId: string;
}): Promise<Result> {
  const { data: existing } = await supabaseAdmin
    .from("characters")
    .select("id")
    .eq("id", args.newCharacterId)
    .maybeSingle();

  if (!existing) {
    const { error: cErr } = await supabaseAdmin.from("characters").insert({
      id: args.newCharacterId,
      name: args.newCharacterId
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      book_id: args.bookId,
    });
    if (cErr) return { ok: false, error: cErr.message };
  }

  if (args.detectionIds.length > 0) {
    const { error } = await supabaseAdmin
      .from("panel_character_detections")
      .update({ character_id: args.newCharacterId, suggested_name: null })
      .in("id", args.detectionIds);
    if (error) return { ok: false, error: error.message };
  }

  if (args.exemplarIds.length > 0) {
    const { error } = await supabaseAdmin
      .from("character_face_exemplars")
      .update({ character_id: args.newCharacterId, suggested_name: null })
      .in("id", args.exemplarIds);
    if (error) return { ok: false, error: error.message };
  }

  revalidate(args.bookId, args.issueId);
  return { ok: true };
}
