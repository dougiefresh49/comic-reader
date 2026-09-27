/**
 * Read-only plan for voice descriptions. SELECTs only, then synthetic cases.
 *
 * Usage: pnpm tsx --env-file=.env scripts/plan-voice-descriptions.ts <bookId> <issueId>
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "~/types/database";
import {
  formatVoiceDecision,
  groupVoiceBubblesByCharacter,
  loadVoiceDescriptionPlanInput,
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
    groups: groupVoiceBubblesByCharacter(bubbles, aliases),
    readyCharacterIds,
    existingCharacterIds,
    designDescriptions,
  });
}

/** Alias-label stability: raw GREEN RANGER + tommy → label Green Ranger both orders. */
function runAliasLabelSynthetic() {
  const aliases: VoiceAliasRow[] = [
    { alias: "tommy", canonical: "Green Ranger" },
  ];
  const readyCharacterIds = new Set<string>();
  const existingCharacterIds = new Set(["green-ranger"]);
  const designDescriptions = new Map<string, string | null>();

  const orderA: VoiceBubbleSnippet[] = [
    {
      speaker: "GREEN RANGER",
      voice_description: "raw caps variant",
      ignored: false,
    },
    {
      speaker: "tommy",
      voice_description: "alias variant",
      ignored: false,
    },
  ];
  const orderB: VoiceBubbleSnippet[] = [
    {
      speaker: "tommy",
      voice_description: "alias variant",
      ignored: false,
    },
    {
      speaker: "GREEN RANGER",
      voice_description: "raw caps variant",
      ignored: false,
    },
  ];

  const planA = planVoiceDescriptions({
    groups: groupVoiceBubblesByCharacter(orderA, aliases),
    readyCharacterIds,
    existingCharacterIds,
    designDescriptions,
  });
  const planB = planVoiceDescriptions({
    groups: groupVoiceBubblesByCharacter(orderB, aliases),
    readyCharacterIds,
    existingCharacterIds,
    designDescriptions,
  });

  return { planA, planB };
}

async function main() {
  const input = await loadVoiceDescriptionPlanInput(supabase, bookId, issueId);
  const plan = planVoiceDescriptions(input);

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
  const tommy = synthetic.decisions.find((d) => d.speakers.includes("tommy"));
  const oldGuy = synthetic.decisions.find((d) =>
    d.speakers.includes("Old Guy"),
  );
  console.log(
    `Character: tommy → "${tommy?.resolvedName}"; Old Guy → "${oldGuy?.resolvedName}"`,
  );

  console.log("--- alias-label synthetic ---");
  const { planA, planB } = runAliasLabelSynthetic();
  const groupA = planA.decisions.find((d) => d.characterId === "green-ranger");
  const groupB = planB.decisions.find((d) => d.characterId === "green-ranger");
  console.log(
    `order GREEN RANGER then tommy → Character: "${groupA?.resolvedName}"`,
  );
  console.log(
    `order tommy then GREEN RANGER → Character: "${groupB?.resolvedName}"`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
