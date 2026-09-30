"use server";

import { createHmac } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { checkAdminAuth } from "~/lib/admin-auth";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { withVoiceOperationClaim } from "./operation-claim";
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
  token: string;
  voiceName: string;
  operation: VoiceOperation;
  eligible: boolean;
  refusals: string[];
  warnings: string[];
  status: SlotStatus;
  sampleCount?: number;
}

function planToken(voice: SlotVoiceRow, operation: VoiceOperation): string {
  return createHmac("sha256", process.env.SUPABASE_SECRET_KEY!)
    .update(
      JSON.stringify([
        operation,
        voice.id,
        voice.status,
        voice.current_elevenlabs_id,
        voice.archived_at,
        voice.source_clip_md5,
      ]),
    )
    .digest("hex");
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
  const status = await slotStatus({ supabase: supabaseAdmin });
  const voice = await readVoice(supabaseAdmin, voiceId);
  if (!voice) throw new Error("Voice not found");
  const result = await runOperation(voice, operation);
  const refusals = [
    ...result.refusals,
    ...(operation === "restore" ? headroomRefusals(status, 1) : []),
  ];
  const plan: VoicePlan = {
    voiceId: voice.id,
    token: planToken(voice, operation),
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

function operationError(error: unknown, uncertain = false): string {
  const message =
    error instanceof ElevenLabsTimeoutError
      ? "ElevenLabs request timed out."
      : error instanceof Error
        ? error.message
        : "Voice operation failed";
  return uncertain
    ? `${message} The change may have landed. Nothing was retried. Check ElevenLabs before repeating the operation.`
    : message;
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
  token: string,
): Promise<{ ok: boolean; message: string }> {
  let uncertain = false;
  try {
    await requireAdmin();
    // Read without voice-slots so Confirm claims before any module call.
    const voiceResult = await supabaseAdmin
      .from("voices")
      .select("*")
      .eq("id", voiceId)
      .single();
    if (voiceResult.error) throw new Error(voiceResult.error.message);
    const previewVoice = voiceResult.data as SlotVoiceRow;
    if (token !== planToken(previewVoice, operation))
      return {
        ok: false,
        message: "Voice changed since this preview. Request a new preview.",
      };
    return await withVoiceOperationClaim(
      supabaseAdmin,
      previewVoice,
      operation,
      async () => {
        // Re-read eligibility only after acquiring the cross-instance claim.
        const { plan } = await buildPlan(voiceId, operation);
        if (token !== plan.token)
          return {
            ok: false,
            message: "Voice changed since this preview. Request a new preview.",
          };
        if (!plan.eligible)
          return { ok: false, message: `Refused: ${plan.refusals.join("; ")}` };
        const freshVoice = await readVoice(supabaseAdmin, voiceId);
        if (!freshVoice || token !== planToken(freshVoice, operation))
          return {
            ok: false,
            message: "Voice changed since this preview. Request a new preview.",
          };
        uncertain = true;
        const result = await runOperation(freshVoice, operation, true);
        if (!result.executed)
          return {
            ok: false,
            message: `Refused: ${result.refusals.join("; ")}`,
          };
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
      },
    );
  } catch (error) {
    return { ok: false, message: operationError(error, uncertain) };
  }
}
