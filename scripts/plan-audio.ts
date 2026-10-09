#!/usr/bin/env node
/**
 * SELECT-only audio plan for an issue. No ElevenLabs client, no DB writes.
 * Speakers are `bubbles.character_id`; each bubble's voice comes from the
 * render chain (`renderVoice` in `~/lib/cast`, #429).
 *
 *   pnpm tsx --env-file=.env scripts/plan-audio.ts <book> <issue>
 */

import { createClient } from "@supabase/supabase-js";
import type { Database } from "~/types/database";
import {
  loadBookCast,
  renderVoice,
  type BookCast,
  type CastRow,
} from "~/lib/cast";
import {
  normalizeAlignment,
  planBubbleVoices,
  planCharactersNeedingVoices,
  readPlanningVoices,
  selectBubblesNeedingAudio,
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

/** An in-memory book cast for the synthetic cases; nothing is read or written. */
function syntheticBook(rows: Partial<CastRow>[]): BookCast {
  return {
    bookId: "synthetic",
    rows: rows.map((r) => ({
      issue_id: "issue-1",
      character_id: "",
      display_name: r.character_id ?? "",
      voice_uuid: null,
      in_issue: true,
      no_audio: false,
      ...r,
    })),
    issueNumber: new Map([["issue-1", 1]]),
    voices: new Map([
      [
        "v-active",
        {
          id: "v-active",
          current_elevenlabs_id: "el-a",
          status: "active",
          run_only: false,
        },
      ],
    ]),
    formOf: new Map(),
    resolve: () => undefined,
  };
}

function runSyntheticCases(): void {
  const syntheticBubbles: BubbleAudioRow[] = [
    {
      id: "b1",
      speaker: "green-ranger",
      ignored: false,
      silent: false,
      audio_storage_path: "b1.mp3",
      text_with_cues: "Already has audio",
      ocr_text: null,
    },
    {
      id: "b2",
      speaker: "green-ranger",
      ignored: true,
      silent: false,
      audio_storage_path: null,
      text_with_cues: "Ignored",
      ocr_text: null,
    },
    {
      id: "b3",
      speaker: "green-ranger",
      ignored: false,
      silent: false,
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

  const bubble = (id: string, characterId: string | null) => ({
    id,
    speaker: characterId,
    character_id: characterId,
    ignored: false,
    silent: false,
    audio_storage_path: null,
    text_with_cues: "Hello",
    ocr_text: null,
  });
  const summary = (plan: ReturnType<typeof planBubbleVoices>) =>
    `toSend=${plan.toSend.length} skipped=${plan.skipped.map((s) => `${s.bubble.id}:${s.reason}`).join(",")}`;

  // A cast row with no voice is membership, not a Voice Design target.
  const noVoice = syntheticBook([{ character_id: "green-ranger" }]);
  const noVoicePlan = planCharactersNeedingVoices(
    ["green-ranger"],
    new Set(["green-ranger"]),
    [],
  );
  console.log(
    `synthetic cast without voice: needDesign=${noVoicePlan.needDesign.length} reuse=${noVoicePlan.reuse.length} ${summary(planBubbleVoices([bubble("b-no-voice", "green-ranger")], noVoice, "issue-1"))}`,
  );

  // "No audio" keeps its voice reference and renders nothing; a removed
  // character and an unassigned bubble render nothing either.
  const stops = syntheticBook([
    { character_id: "silent", voice_uuid: "v-active", no_audio: true },
    { character_id: "gone", voice_uuid: "v-active", in_issue: false },
    { character_id: "voiced", voice_uuid: "v-active" },
  ]);
  console.log(
    `synthetic chain stops: ${summary(
      planBubbleVoices(
        [
          bubble("b-silent", "silent"),
          bubble("b-gone", "gone"),
          bubble("b-unassigned", null),
          bubble("b-voiced", "voiced"),
        ],
        stops,
        "issue-1",
      ),
    )}`,
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

  const [{ data: bubbleRows, error: bubErr }, book] = await Promise.all([
    supabase
      .from("bubbles")
      .select(
        "id, speaker, character_id, ignored, silent, audio_storage_path, text_with_cues, ocr_text",
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("ignored", false),
    loadBookCast(supabase, bookId),
  ]);
  if (bubErr) throw new Error(bubErr.message);

  const bubbles = bubbleRows ?? [];
  const speakers = [
    ...new Set(
      bubbles.flatMap((b) => (b.character_id ? [b.character_id] : [])),
    ),
  ].sort();
  const castMembers = new Set(
    book.rows.flatMap((r) =>
      r.issue_id === issueId && r.character_id ? [r.character_id] : [],
    ),
  );
  const voices = await readPlanningVoices(supabase, [
    ...speakers,
    ...castMembers,
  ]);

  const byReason = new Map<string, string[]>();
  for (const id of speakers) {
    const found = renderVoice(book, id, issueId);
    const key = found.ok ? "voiced" : found.reason;
    byReason.set(key, [...(byReason.get(key) ?? []), id]);
  }
  const unassigned = bubbles.filter((b) => !b.character_id).length;
  const sendPlan = planBubbleVoices(bubbles, book, issueId);
  const voicePlan = planCharactersNeedingVoices(speakers, castMembers, voices);

  console.log(
    `${speakers.length} speakers (character ids), ${byReason.get("voiced")?.length ?? 0} voiced, ${unassigned} unassigned bubbles, ${sendPlan.toSend.length} bubbles to send, ${voicePlan.needDesign.length} need Voice Design`,
  );
  for (const [reason, ids] of [...byReason].sort())
    if (reason !== "voiced") console.log(`${reason}=${ids.join(",")}`);
  if (voicePlan.reuse.length > 0) {
    console.log(
      `would_reuse_castlist=${voicePlan.reuse.map((r) => r.characterId).join(",")}`,
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
