"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { checkAdminAuth } from "~/lib/admin-auth";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  archiveVoice,
  restoreVoice,
  snapshotSample,
  slotStatus,
  headroomRefusals,
  readVoice,
  ElevenLabsTimeoutError,
  type SlotStatus,
  type VoiceRow as SlotVoiceRow,
} from "~/lib/voice-slots";

async function requireAdmin() {
  const auth = checkAdminAuth((await headers()).get("authorization"));
  if (!auth.ok) throw new Error(auth.message);
}

export async function toggleKeepActive(voiceId: string, keepActive: boolean) {
  await requireAdmin();
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
  await requireAdmin();
  const { data, error } = await supabaseAdmin
    .from("voices")
    .select(
      "id, display_name, series_id, status, current_elevenlabs_id, keep_active, source_clip_path, design_prompt, created_at, archived_at",
    )
    .order("display_name");
  if (error) throw new Error(error.message);
  return (data ?? []) as VoiceRow[];
}

export type VoiceOperation = "archive" | "restore" | "snapshot";

export interface VoicePlan {
  voiceId: string;
  voiceName: string;
  operation: VoiceOperation;
  eligible: boolean;
  refusals: string[];
  warnings: string[];
  status: SlotStatus;
  sampleCount?: number;
}

function runOperation(
  voice: SlotVoiceRow,
  operation: VoiceOperation,
  execute = false,
) {
  const deps = { supabase: supabaseAdmin };
  switch (operation) {
    case "archive":
      return archiveVoice(deps, voice, { execute });
    case "restore":
      return restoreVoice(deps, voice, { execute });
    case "snapshot":
      return snapshotSample(deps, voice, { execute });
    default:
      throw new Error("Unknown voice operation");
  }
}

async function buildPlan(voiceId: string, operation: VoiceOperation) {
  const voice = await readVoice(supabaseAdmin, voiceId);
  if (!voice) throw new Error("Voice not found");
  const status = await slotStatus({ supabase: supabaseAdmin });
  const result = await runOperation(voice, operation);
  const refusals = [
    ...result.refusals,
    ...(operation === "restore" ? headroomRefusals(status, 1) : []),
  ];
  const plan: VoicePlan = {
    voiceId: voice.id,
    voiceName: voice.display_name,
    operation,
    eligible: result.ok && refusals.length === 0,
    refusals,
    warnings: "warnings" in result ? result.warnings : [],
    status,
    ...("samples" in result ? { sampleCount: result.samples.length } : {}),
  };
  return { voice, plan };
}

function operationError(error: unknown): string {
  if (error instanceof ElevenLabsTimeoutError)
    return "ElevenLabs request timed out. The first request may have landed. Nothing was retried. Check ElevenLabs before running again.";
  return error instanceof Error ? error.message : "Voice operation failed";
}

export async function planVoiceOperation(
  voiceId: string,
  operation: VoiceOperation,
): Promise<{ ok: true; plan: VoicePlan } | { ok: false; error: string }> {
  try {
    await requireAdmin();
    const { plan } = await buildPlan(voiceId, operation);
    return { ok: true, plan };
  } catch (error) {
    return { ok: false, error: operationError(error) };
  }
}

export async function executeVoiceOperation(
  voiceId: string,
  operation: VoiceOperation,
): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
    const { voice, plan } = await buildPlan(voiceId, operation);
    if (!plan.eligible)
      return { ok: false, message: `Refused: ${plan.refusals.join("; ")}` };
    const result = await runOperation(voice, operation, true);
    if (!result.executed)
      return { ok: false, message: `Refused: ${result.refusals.join("; ")}` };
    revalidatePath("/admin/voices", "page");
    return {
      ok: true,
      message:
        operation === "archive"
          ? "Archived. The ElevenLabs slot is free."
          : operation === "restore"
            ? "Restored. The new ElevenLabs ID is saved."
            : "Snapshot saved and hash-checked in the private bucket.",
    };
  } catch (error) {
    return { ok: false, message: operationError(error) };
  }
}
