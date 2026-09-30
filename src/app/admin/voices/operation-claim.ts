import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VoiceRow } from "~/lib/voice-slots";
import type { VoiceOperation } from "./actions";

// #102 adds these columns; the orchestrator regenerates DB types after applying it.
interface VoiceClaimRow {
  operation_claim: string | null;
  operation_claimed_at: string | null;
}

export async function withVoiceOperationClaim<T>(
  supabase: SupabaseClient,
  voice: VoiceRow,
  operation: VoiceOperation,
  run: () => Promise<T>,
): Promise<T> {
  const claim = `${operation}:${randomUUID()}`;
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  let query = supabase
    .from("voices")
    .update({
      operation_claim: claim,
      // PostgreSQL timestamp input "now" uses the transaction's start time.
      operation_claimed_at: "now",
    })
    .eq("id", voice.id)
    .eq("status", voice.status);
  // Match every nullable row field covered by the plan token in the same UPDATE.
  for (const field of [
    "current_elevenlabs_id",
    "archived_at",
    "source_clip_md5",
  ] as const) {
    query =
      voice[field] === null
        ? query.is(field, null)
        : query.eq(field, voice[field]);
  }
  const { data, error } = await query
    .or(`operation_claim.is.null,operation_claimed_at.lt.${staleBefore}`)
    .select("operation_claim, operation_claimed_at");
  if (error) throw new Error(`Claim voice: ${error.message}`);
  const claimed = (data ?? []) as VoiceClaimRow[];
  if (!claimed.some((row) => row.operation_claim === claim))
    throw new Error("another operation holds this voice");
  try {
    return await run();
  } finally {
    const released = await supabase
      .from("voices")
      .update({ operation_claim: null, operation_claimed_at: null })
      .eq("id", voice.id)
      .eq("operation_claim", claim);
    if (released.error)
      throw new Error(
        `Release voice claim: ${released.error.message}. Check ElevenLabs before repeating the operation.`,
      );
  }
}
