import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VoiceRow } from "./types";

/** What a claim is for; the claim string starts with it. */
export type VoiceClaimOperation =
  | "archive"
  | "restore"
  | "snapshot"
  | "clone"
  | "design";

interface VoiceClaimRow {
  operation_claim: string | null;
  operation_claimed_at: string | null;
}

/** A claim older than ten minutes is stale and can be taken over. */
export function noActiveVoiceClaimFilter(): string {
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  return `operation_claim.is.null,operation_claimed_at.lt.${staleBefore}`;
}

/**
 * Runs `run` while holding the cross-instance claim on one `voices` row
 * (#102): the claim only lands when the row still matches what the caller
 * read (status, ElevenLabs id, archived_at, snapshot hash) and no live claim
 * is on it. Released in `finally`, whatever `run` did.
 */
export async function withVoiceOperationClaim<T>(
  supabase: SupabaseClient,
  voice: VoiceRow,
  operation: VoiceClaimOperation,
  run: () => Promise<T>,
): Promise<T> {
  const claim = `${operation}:${randomUUID()}`;
  try {
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
      .or(noActiveVoiceClaimFilter())
      .select("operation_claim, operation_claimed_at");
    if (error) throw new Error(`Claim voice: ${error.message}`);
    const claimed = (data ?? []) as VoiceClaimRow[];
    if (!claimed.some((row) => row.operation_claim === claim))
      throw new Error("another operation holds this voice");
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
