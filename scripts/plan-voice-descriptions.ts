/**
 * Read-only plan for voice descriptions. SELECTs only, then one synthetic case.
 *
 * Usage: pnpm tsx --env-file=.env scripts/plan-voice-descriptions.ts <bookId> <issueId>
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "~/types/database";
import {
  formatVoiceDecision,
  planVoiceDescriptions,
  type VoiceAliasRow,
  type VoiceBubbleSnippet,
} from "~/workflows/steps/voice";

const bookArg = process.argv[2];
const issueArg = process.argv[3];

if (!bookArg || !issueArg) {
  console.error(
    "Usage: pnpm tsx --env-file=.env scripts/plan-voice-descriptions.ts <bookId> <issueId>",
  );
  process.exit(1);
}

const bookId: string = bookArg;
const issueId: string = issueArg;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const supabase = createClient<Database>(url, key, {
  auth: { persistSession: false },
});

function speakerMatchKey(speaker: string): string {
  return speaker.toLowerCase().trim().replace(/-/g, " ");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

async function planForIssue(book: string, issue: string) {
  const { data: bubbleRows, error: bubbleErr } = await supabase
    .from("bubbles")
    .select("speaker, voice_description, ignored")
    .eq("book_id", book)
    .eq("issue_id", issue)
    .not("voice_description", "is", null)
    .not("speaker", "is", null);

  if (bubbleErr) throw new Error(bubbleErr.message);

  const { data: aliasRows, error: aliasErr } = await supabase
    .from("aliases")
    .select("alias, canonical, scope, scope_id")
    .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${book})`);

  if (aliasErr) throw new Error(aliasErr.message);

  const bubbles: VoiceBubbleSnippet[] = [];
  for (const row of bubbleRows ?? []) {
    if (!row.speaker || !row.voice_description) continue;
    bubbles.push({
      speaker: row.speaker,
      voice_description: row.voice_description,
      ignored: row.ignored,
    });
  }

  const aliases: VoiceAliasRow[] = (aliasRows ?? []).map((row) => ({
    alias: row.alias,
    canonical: row.canonical,
  }));

  const aliasMap = new Map<string, string>();
  for (const a of aliases) {
    aliasMap.set(a.alias.toLowerCase().trim(), a.canonical);
  }

  const resolvedIds = new Set<string>();
  for (const b of bubbles) {
    if (b.ignored) continue;
    const speaker = b.speaker?.trim();
    if (!speaker) continue;
    const key = speakerMatchKey(speaker);
    const resolved = aliasMap.get(key) ?? speaker;
    resolvedIds.add(slugify(resolved));
  }
  const resolvedIdList = [...resolvedIds];

  const readyCharacterIds = new Set<string>();
  const designDescriptions = new Map<string, string | null>();
  const existingCharacterIds = new Set<string>();

  if (resolvedIdList.length > 0) {
    const { data: caRows, error: caErr } = await supabase
      .from("character_appearances")
      .select(
        "id, character_id, voice_status, voice_model_status, voice_description",
      )
      .in("character_id", resolvedIdList);

    if (caErr) throw new Error(caErr.message);

    for (const r of caRows ?? []) {
      if (r.voice_status === "ready" || r.voice_model_status === "ready") {
        readyCharacterIds.add(r.character_id);
      }
      if (r.id.endsWith("-voice-design")) {
        designDescriptions.set(r.id, r.voice_description);
      }
    }

    const { data: charRows, error: charErr } = await supabase
      .from("characters")
      .select("id")
      .in("id", resolvedIdList);

    if (charErr) throw new Error(charErr.message);

    for (const r of charRows ?? []) {
      existingCharacterIds.add(r.id);
    }
  }

  return planVoiceDescriptions({
    bubbles,
    aliases,
    readyCharacterIds,
    existingCharacterIds,
    designDescriptions,
  });
}

function runSynthetic() {
  const aliases: VoiceAliasRow[] = [
    { alias: "tommy", canonical: "Green Ranger" },
  ];
  const bubbles: VoiceBubbleSnippet[] = [
    {
      speaker: "Dr. Boyd",
      voice_description: "calm clinician",
      ignored: false,
    },
    {
      speaker: "tommy",
      voice_description: "earnest teen hero",
      ignored: false,
    },
    {
      speaker: "New Guy",
      voice_description: "unknown newcomer",
      ignored: false,
    },
    {
      speaker: "Old Guy",
      voice_description: "gravelly elder",
      ignored: false,
    },
  ];

  const readyCharacterIds = new Set(["dr-boyd", "green-ranger"]);
  const existingCharacterIds = new Set(["dr-boyd", "green-ranger", "old-guy"]);
  const designDescriptions = new Map<string, string | null>();

  return planVoiceDescriptions({
    bubbles,
    aliases,
    readyCharacterIds,
    existingCharacterIds,
    designDescriptions,
  });
}

async function main() {
  const plan = await planForIssue(bookId, issueId);

  console.log(
    `${plan.characterCount} characters, ${plan.skippedReady} skipped (ready voice), ${plan.toDescribe} to describe`,
  );

  for (const d of plan.decisions) {
    console.log(
      `${formatVoiceDecision(d)} (${d.snippetCount} snippet${d.snippetCount === 1 ? "" : "s"})`,
    );
  }

  console.log("--- synthetic ---");
  const synthetic = runSynthetic();
  for (const d of synthetic.decisions) {
    console.log(formatVoiceDecision(d));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
