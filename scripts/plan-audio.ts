#!/usr/bin/env node
/**
 * SELECT-only audio plan for an issue. No ElevenLabs client, no DB writes.
 *
 *   pnpm tsx --env-file=.env scripts/plan-audio.ts <book> <issue>
 */

import { createClient } from "@supabase/supabase-js";
import type { Database } from "~/types/database";
import {
  buildAliasMap,
  buildCastVoiceMap,
  normalizeAlignment,
  planCharactersNeedingVoices,
  planSpeakerMatching,
  selectBubblesNeedingAudio,
  type AppearanceRow,
  type BubbleAudioRow,
} from "~/workflows/steps/audio-plan";

function parseArgs(): { book: string; issue: string } {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const book = args[0]?.trim() ?? "";
  let issue = args[1]?.trim() ?? "";
  if (issue && !issue.startsWith("issue-")) issue = `issue-${issue}`;

  if (!book || !issue) {
    console.error("Usage: plan-audio.ts <book> <issue>");
    process.exit(1);
  }
  return { book, issue };
}

function runSyntheticCases(): void {
  const syntheticBubbles: BubbleAudioRow[] = [
    {
      id: "b1",
      speaker: "green-ranger",
      ignored: false,
      audio_storage_path: "b1.mp3",
      text_with_cues: "Already has audio",
      ocr_text: null,
    },
    {
      id: "b2",
      speaker: "green-ranger",
      ignored: true,
      audio_storage_path: null,
      text_with_cues: "Ignored",
      ocr_text: null,
    },
    {
      id: "b3",
      speaker: "green-ranger",
      ignored: false,
      audio_storage_path: null,
      text_with_cues: null,
      ocr_text: "Needs audio",
    },
  ];
  const selected = selectBubblesNeedingAudio(syntheticBubbles);
  console.log(
    `synthetic bubble selection: ${selected.length} of ${syntheticBubbles.length} bubbles selected (${selected.map((b) => b.id).join(",")})`,
  );

  const normalized = normalizeAlignment({
    characters: ["a", "b"],
    characterStartTimesSeconds: [0, 0.1],
    characterEndTimesSeconds: [0.1, 0.2],
  });
  console.log(
    `synthetic alignment keys: ${normalized ? Object.keys(normalized).join(", ") : "(null)"}`,
  );
}

async function planIssue(bookId: string, issueId: string): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  }

  const supabase = createClient<Database>(url, key, {
    auth: { persistSession: false },
  });

  const [
    { data: bubbleRows, error: bubErr },
    { data: aliasRows, error: aliasErr },
    { data: castRows, error: castErr },
    { data: appearanceRows, error: appErr },
  ] = await Promise.all([
    supabase
      .from("bubbles")
      .select(
        "id, speaker, ignored, audio_storage_path, text_with_cues, ocr_text",
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    supabase
      .from("aliases")
      .select("alias, canonical, scope, scope_id")
      .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`),
    supabase
      .from("castlist")
      .select("character, voice_id")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    supabase
      .from("character_appearances")
      .select(
        "id, character_id, voice_id, voice_status, voice_description, voice_created_at",
      ),
  ]);

  if (bubErr) throw new Error(bubErr.message);
  if (aliasErr) throw new Error(aliasErr.message);
  if (castErr) throw new Error(castErr.message);
  if (appErr) throw new Error(appErr.message);

  const aliasMap = buildAliasMap(aliasRows ?? []);
  const castVoiceMap = buildCastVoiceMap(castRows ?? []);
  const appearances = (appearanceRows ?? []) as AppearanceRow[];

  const rawSpeakers = (bubbleRows ?? [])
    .map((b) => b.speaker)
    .filter((s): s is string => !!s);

  const matching = planSpeakerMatching(rawSpeakers, aliasMap, castVoiceMap);
  const bubbles = (bubbleRows ?? []) as BubbleAudioRow[];
  const toSend = selectBubblesNeedingAudio(bubbles);
  const voicePlan = planCharactersNeedingVoices(
    rawSpeakers,
    aliasMap,
    castVoiceMap,
    appearances,
  );

  console.log(
    `${matching.distinctSpeakers.length} distinct speaker strings, ${matching.matched.length} matched, ${matching.unmatched.length} unmatched, ${toSend.length} bubbles to send, ${voicePlan.needDesign.length} need Voice Design`,
  );

  if (matching.unmatched.length > 0) {
    console.log(`unmatched=${matching.unmatched.join(",")}`);
  }
  if (voicePlan.reuse.length > 0) {
    console.log(
      `would_reuse_castlist=${voicePlan.reuse.map((r) => r.character).join(",")}`,
    );
  }
  if (voicePlan.needDesign.length > 0) {
    console.log(`need_voice_design=${voicePlan.needDesign.join(",")}`);
  }
}

async function main() {
  const { book, issue } = parseArgs();
  runSyntheticCases();
  await planIssue(book, issue);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
