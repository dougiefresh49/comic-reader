"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";

export async function selectAppearance(
  appearanceId: string,
  characterId: string,
) {
  // Mark this appearance as "in_progress" — actual clip download + voice model
  // creation are handled by background workers (or scripts) that watch for
  // voice_model_status='processing' rows.
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("character_appearances")
    .update({
      voice_model_status: "processing",
      voice_model_started_at: now,
      voice_model_error: null,
    })
    .eq("id", appearanceId);
  if (error) return { ok: false, error: error.message };

  // Also mark the casting_tasks row as in_progress
  await supabaseAdmin
    .from("casting_tasks")
    .update({ status: "in_progress" })
    .eq("character_id", characterId)
    .eq("status", "pending");

  revalidatePath("/admin/characters/casting", "page");
  return { ok: true };
}

export async function markCastingComplete(
  taskId: string,
  characterId: string,
  voiceId: string,
  appearanceId: string,
  bookId: string,
  issueId: string,
) {
  const now = new Date().toISOString();

  const { error: aErr } = await supabaseAdmin
    .from("character_appearances")
    .update({
      voice_id: voiceId,
      voice_model_status: "ready",
      voice_status: "ready",
    })
    .eq("id", appearanceId);
  if (aErr) return { ok: false, error: aErr.message };

  const { error: tErr } = await supabaseAdmin
    .from("casting_tasks")
    .update({ status: "complete", completed_at: now })
    .eq("id", taskId);
  if (tErr) return { ok: false, error: tErr.message };

  // Add to castlist if not already there
  const { data: castRow } = await supabaseAdmin
    .from("castlist")
    .select("character")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("character", characterId)
    .maybeSingle();
  if (!castRow) {
    await supabaseAdmin.from("castlist").insert({
      book_id: bookId,
      issue_id: issueId,
      character: characterId,
      voice_id: voiceId,
    });
  }

  revalidatePath("/admin/characters/casting", "page");
  revalidatePath("/admin", "page");
  return { ok: true };
}

export async function skipCastingTask(taskId: string) {
  const { error } = await supabaseAdmin
    .from("casting_tasks")
    .update({ status: "skipped", completed_at: new Date().toISOString() })
    .eq("id", taskId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/characters/casting", "page");
  return { ok: true };
}
