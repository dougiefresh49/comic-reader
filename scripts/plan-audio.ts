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
  buildCastIndex,
  formatCastConflicts,
  normalizeAlignment,
  planBubblesToSend,
  planCharactersNeedingVoices,
  planSpeakerMatching,
  readPlanningAppearances,
  selectBubblesNeedingAudio,
  speakerKeys,
  type BubbleAudioRow,
  type CastRow,
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

  // Finding 1: cast row with null voice_id is membership, not a Voice Design target.
  const nullVoiceCast: CastRow[] = [
    { character: "green-ranger", voice_id: null },
  ];
  const nullVoiceIndex = buildCastIndex(nullVoiceCast);
  const nullVoiceAlias = buildAliasMap([]);
  const nullVoiceSpeakers = ["green-ranger"];
  const nullVoicePlan = planCharactersNeedingVoices(
    nullVoiceSpeakers,
    nullVoiceAlias,
    nullVoiceIndex,
    [],
  );
  const nullVoiceBubble: BubbleAudioRow = {
    id: "b-null-voice",
    speaker: "green-ranger",
    ignored: false,
    audio_storage_path: null,
    text_with_cues: "Hello",
    ocr_text: null,
  };
  const nullVoiceSend = planBubblesToSend(
    [nullVoiceBubble],
    nullVoiceAlias,
    nullVoiceIndex,
  );
  const nullSkip = nullVoiceSend.skipped
    .map((s) => `${s.bubble.id}:${s.reason}`)
    .join(",");
  console.log(
    `synthetic cast without voice: needDesign=${nullVoicePlan.needDesign.length} reuse=${nullVoicePlan.reuse.length} toSend=${nullVoiceSend.toSend.length} skipped=${nullSkip}`,
  );

  // Finding 2: same slug, different voice_ids is a conflict naming both rows.
  const conflictCast: CastRow[] = [
    { character: "Green Ranger", voice_id: "voice-a" },
    { character: "green-ranger", voice_id: "voice-b" },
  ];
  const conflictIndex = buildCastIndex(conflictCast);
  const conflictMatch = planSpeakerMatching(
    ["Green Ranger", "green-ranger"],
    buildAliasMap([]),
    conflictIndex,
  );
  console.log(
    `synthetic castlist conflict: count=${conflictIndex.conflicts.length} detail=${formatCastConflicts(conflictIndex.conflicts)} conflicted=${conflictMatch.conflicted.join(",")} cast_without_voice=${conflictMatch.castWithoutVoice.length}`,
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
  ] = await Promise.all([
    supabase
      .from("bubbles")
      .select(
        "id, speaker, ignored, audio_storage_path, text_with_cues, ocr_text",
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("ignored", false),
    supabase
      .from("aliases")
      .select("alias, canonical, scope, scope_id")
      .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`),
    supabase
      .from("castlist")
      .select("character, voice_id")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
  ]);

  if (bubErr) throw new Error(bubErr.message);
  if (aliasErr) throw new Error(aliasErr.message);
  if (castErr) throw new Error(castErr.message);

  const aliasMap = buildAliasMap(aliasRows ?? []);
  const cast = buildCastIndex(castRows ?? []);

  const rawSpeakers = (bubbleRows ?? [])
    .map((b) => b.speaker)
    .filter((s): s is string => !!s);
  const appearances = await readPlanningAppearances(
    supabase,
    speakerKeys(rawSpeakers, aliasMap),
  );

  const matching = planSpeakerMatching(rawSpeakers, aliasMap, cast);
  const bubbles = (bubbleRows ?? []) as BubbleAudioRow[];
  const sendPlan = planBubblesToSend(bubbles, aliasMap, cast);
  const voicePlan = planCharactersNeedingVoices(
    rawSpeakers,
    aliasMap,
    cast,
    appearances,
  );

  const bubblesToSendPart =
    cast.conflicts.length > 0
      ? "0 bubbles to send (blocked by conflicts)"
      : `${sendPlan.toSend.length} bubbles to send`;

  console.log(
    `${matching.distinctSpeakers.length} distinct speaker strings, ${matching.matched.length} matched, ${matching.unmatched.length} unmatched, ${bubblesToSendPart}, ${voicePlan.needDesign.length} need Voice Design`,
  );
  console.log(`castlist conflicts: ${cast.conflicts.length}`);

  if (cast.conflicts.length > 0) {
    console.log(`conflicts=${formatCastConflicts(cast.conflicts)}`);
  }
  if (matching.conflicted.length > 0) {
    console.log(`conflicted_speakers=${matching.conflicted.join(",")}`);
  }
  if (matching.unmatched.length > 0) {
    console.log(`unmatched=${matching.unmatched.join(",")}`);
  }
  if (matching.castWithoutVoice.length > 0) {
    console.log(`cast_without_voice=${matching.castWithoutVoice.join(",")}`);
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
