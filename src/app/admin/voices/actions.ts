"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";

export async function toggleKeepActive(voiceId: string, keepActive: boolean) {
  const { error } = await supabaseAdmin
    .from("voices")
    .update({ keep_active: keepActive })
    .eq("id", voiceId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/voices", "page");
  return { ok: true };
}

export interface VoiceRow {
  id: string;
  display_name: string;
  series_id: string | null;
  status: string;
  current_elevenlabs_id: string | null;
  keep_active: boolean;
  source_clip_path: string | null;
  design_prompt: string | null;
  created_at: string;
  archived_at: string | null;
}

export async function getVoices(): Promise<VoiceRow[]> {
  const { data, error } = await supabaseAdmin
    .from("voices")
    .select(
      "id, display_name, series_id, status, current_elevenlabs_id, keep_active, source_clip_path, design_prompt, created_at, archived_at",
    )
    .order("display_name");
  if (error) throw new Error(error.message);
  return (data ?? []) as VoiceRow[];
}
