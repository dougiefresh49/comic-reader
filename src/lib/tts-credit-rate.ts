/**
 * The one home for the credits a TTS render bills per request character
 * (#838), measured from the newest billed `llm_calls` rows. A hard-coded rate
 * goes stale: `eleven_v4` billed about 0.12 credits per character through
 * 2026-10-13 and about 0.44 from 2026-10-15 on, with the same model, no TTS
 * code change, and `GET /v1/models` still reporting a multiplier of 1.0.
 * `llm_calls.credits` holds the `character-cost` header ElevenLabs bills
 * (`creditsFor` in `llm-usage.ts`). #106's preflight estimate can import
 * `loadTtsCreditRate` and `estimateCredits` from here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { TTS_MODEL } from "./tts-request";

/** Credits per request character, and how many renders it was measured over. */
export interface TtsCreditRate {
  perCharacter: number;
  renders: number;
}

/** The billed renders the rate is measured over, newest first. */
const RATE_RENDERS = 20;

/**
 * The billed rate of the newest `TTS_MODEL` renders: their credits over their
 * characters. Never rejects: null when none are logged or the read fails
 * (the error is logged), and the caller shows characters instead.
 */
export async function loadTtsCreditRate(
  client: SupabaseClient,
): Promise<TtsCreditRate | null> {
  let rows: { characters: number; credits: number }[];
  try {
    const { data, error } = await client
      .from("llm_calls")
      .select("characters, credits")
      .eq("provider", "elevenlabs")
      .eq("model", TTS_MODEL)
      .eq("ok", true)
      .gt("characters", 0)
      .not("credits", "is", null)
      .order("created_at", { ascending: false })
      .limit(RATE_RENDERS);
    if (error) throw error;
    rows = (data ?? []) as typeof rows;
  } catch (error) {
    console.error("tts credit rate, reading llm_calls:", error);
    return null;
  }
  if (rows.length === 0) return null;
  let characters = 0;
  let credits = 0;
  for (const r of rows) {
    characters += r.characters;
    credits += r.credits;
  }
  return { perCharacter: credits / characters, renders: rows.length };
}

/** The credits `characters` request characters bill at `rate`, rounded up. */
export function estimateCredits(
  characters: number,
  rate: TtsCreditRate,
): number {
  return Math.ceil(characters * rate.perCharacter);
}
