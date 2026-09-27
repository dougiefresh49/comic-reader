import { GoogleGenAI, createPartFromText } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GEMINI_MEDIUM } from "~/lib/models";
import type { Database } from "~/types/database";

/** Copied from scripts/utils/registry.ts slugify. Do not import that module. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function speakerMatchKey(speaker: string): string {
  return speaker.toLowerCase().trim().replace(/-/g, " ");
}

export type VoiceBubbleSnippet = {
  speaker: string;
  voice_description: string;
  ignored?: boolean | null;
};

export type VoiceAliasRow = {
  alias: string;
  canonical: string;
};

export type VoiceDescriptionDecisionKind =
  | "skip_narrator"
  | "skip_ready"
  | "skip_has_description"
  | "skip_unresolved"
  | "describe";

export type VoiceDescriptionDecision = {
  characterId: string;
  /** Alias target when aliased, otherwise the raw speaker string. */
  resolvedName: string;
  /** Raw speaker strings that resolved to this character id. */
  speakers: string[];
  snippetCount: number;
  snippets: string[];
  decision: VoiceDescriptionDecisionKind;
  appearanceId: string | null;
};

export type VoiceDescriptionPlan = {
  decisions: VoiceDescriptionDecision[];
  characterCount: number;
  skippedReady: number;
  skippedNarrator: number;
  skippedHasDescription: number;
  skippedUnresolved: number;
  toDescribe: number;
};

export type PlanVoiceDescriptionsInput = {
  bubbles: VoiceBubbleSnippet[];
  /** Already scoped: global, or book-scoped for this book. */
  aliases: VoiceAliasRow[];
  readyCharacterIds: ReadonlySet<string>;
  existingCharacterIds: ReadonlySet<string>;
  /** Map of `<id>-voice-design` appearance id → voice_description (may be null). */
  designDescriptions: ReadonlyMap<string, string | null>;
};

function resolveSpeaker(
  speaker: string,
  aliasMap: Map<string, string>,
): { resolvedName: string; characterId: string; aliased: boolean } {
  const key = speakerMatchKey(speaker);
  const aliasedTo = aliasMap.get(key);
  const resolvedName = aliasedTo ?? speaker;
  const characterId = slugify(resolvedName);
  return {
    resolvedName,
    characterId,
    aliased: aliasedTo !== undefined,
  };
}

/**
 * Pure plan: group non-ignored bubble voice snippets by resolved character id
 * and decide skip vs describe. No I/O.
 */
export function planVoiceDescriptions(
  input: PlanVoiceDescriptionsInput,
): VoiceDescriptionPlan {
  const aliasMap = new Map<string, string>();
  for (const row of input.aliases) {
    aliasMap.set(row.alias.toLowerCase().trim(), row.canonical);
  }

  type Acc = {
    speakers: Set<string>;
    snippets: string[];
    resolvedName: string;
  };
  const byCharacter = new Map<string, Acc>();

  for (const bubble of input.bubbles) {
    if (bubble.ignored) continue;
    const speaker = bubble.speaker?.trim();
    const desc = bubble.voice_description?.trim();
    if (!speaker || !desc) continue;

    const { characterId, resolvedName } = resolveSpeaker(speaker, aliasMap);
    let acc = byCharacter.get(characterId);
    if (!acc) {
      acc = { speakers: new Set(), snippets: [], resolvedName };
      byCharacter.set(characterId, acc);
    }
    acc.speakers.add(speaker);
    acc.snippets.push(desc);
  }

  const decisions: VoiceDescriptionDecision[] = [];
  let skippedReady = 0;
  let skippedNarrator = 0;
  let skippedHasDescription = 0;
  let skippedUnresolved = 0;
  let toDescribe = 0;

  const characterIds = [...byCharacter.keys()].sort();
  for (const characterId of characterIds) {
    const acc = byCharacter.get(characterId)!;
    const speakers = [...acc.speakers].sort();
    const appearanceId = `${characterId}-voice-design`;
    const base = {
      characterId,
      resolvedName: acc.resolvedName,
      speakers,
      snippetCount: acc.snippets.length,
      snippets: acc.snippets,
    };

    if (characterId === "narrator") {
      decisions.push({
        ...base,
        decision: "skip_narrator",
        appearanceId: null,
      });
      skippedNarrator++;
      continue;
    }

    if (input.readyCharacterIds.has(characterId)) {
      decisions.push({
        ...base,
        decision: "skip_ready",
        appearanceId: null,
      });
      skippedReady++;
      continue;
    }

    const existingDesc = input.designDescriptions.get(appearanceId);
    if (existingDesc != null && existingDesc.trim() !== "") {
      decisions.push({
        ...base,
        decision: "skip_has_description",
        appearanceId,
      });
      skippedHasDescription++;
      continue;
    }

    if (!input.existingCharacterIds.has(characterId)) {
      decisions.push({
        ...base,
        decision: "skip_unresolved",
        appearanceId: null,
      });
      skippedUnresolved++;
      continue;
    }

    decisions.push({
      ...base,
      decision: "describe",
      appearanceId,
    });
    toDescribe++;
  }

  return {
    decisions,
    characterCount: decisions.length,
    skippedReady,
    skippedNarrator,
    skippedHasDescription,
    skippedUnresolved,
    toDescribe,
  };
}

/** Format one decision for the acceptance script / logs. */
export function formatVoiceDecision(d: VoiceDescriptionDecision): string {
  const speakerSlug = slugify(d.speakers[0] ?? d.characterId);
  const label =
    d.speakers.length === 1 && speakerSlug !== d.characterId
      ? `${speakerSlug} → ${d.characterId}`
      : d.characterId;

  switch (d.decision) {
    case "skip_narrator":
      return `${label}: skip narrator`;
    case "skip_ready":
      return `${label}: skip ready`;
    case "skip_has_description":
      return `${label}: skip has description (${d.appearanceId})`;
    case "skip_unresolved":
      return `${label}: skip unresolved (no characters row)`;
    case "describe":
      return `${label}: describe → ${d.appearanceId}`;
  }
}

/**
 * SELECT-only loader for planVoiceDescriptions. Shared by the step and the
 * acceptance script so speaker resolution and the four queries live in one place.
 */
export async function loadVoiceDescriptionPlanInput(
  client: SupabaseClient<Database>,
  bookId: string,
  issueId: string,
): Promise<PlanVoiceDescriptionsInput> {
  const { data: bubbleRows, error: bubbleErr } = await client
    .from("bubbles")
    .select("speaker, voice_description, ignored")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .not("voice_description", "is", null)
    .not("speaker", "is", null);

  if (bubbleErr) throw new Error(bubbleErr.message);

  const { data: aliasRows, error: aliasErr } = await client
    .from("aliases")
    .select("alias, canonical, scope, scope_id")
    .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`);

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
    resolvedIds.add(resolveSpeaker(speaker, aliasMap).characterId);
  }
  const resolvedIdList = [...resolvedIds];

  const readyCharacterIds = new Set<string>();
  const designDescriptions = new Map<string, string | null>();
  const existingCharacterIds = new Set<string>();

  if (resolvedIdList.length > 0) {
    const { data: caRows, error: caErr } = await client
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

    const { data: charRows, error: charErr } = await client
      .from("characters")
      .select("id")
      .in("id", resolvedIdList);

    if (charErr) throw new Error(charErr.message);

    for (const r of charRows ?? []) {
      existingCharacterIds.add(r.id);
    }
  }

  return {
    bubbles,
    aliases,
    readyCharacterIds,
    existingCharacterIds,
    designDescriptions,
  };
}

export async function generateVoiceDescriptions(
  bookId: string,
  issueId: string,
) {
  "use step";
  const { FatalError } = await import("workflow");
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new FatalError("GEMINI_API_KEY not set");
  const gemini = new GoogleGenAI({ apiKey });

  let input: PlanVoiceDescriptionsInput;
  try {
    input = await loadVoiceDescriptionPlanInput(supabase, bookId, issueId);
  } catch (e) {
    throw new FatalError(e instanceof Error ? e.message : String(e));
  }

  const plan = planVoiceDescriptions(input);

  console.log(
    `[voice-desc] ${bookId}/${issueId}: ${plan.characterCount} characters, ${plan.skippedReady} skipped (ready voice), ${plan.toDescribe} to describe` +
      (plan.skippedUnresolved > 0
        ? `, ${plan.skippedUnresolved} skipped (unresolved)`
        : "") +
      (plan.skippedHasDescription > 0
        ? `, ${plan.skippedHasDescription} skipped (has description)`
        : "") +
      (plan.skippedNarrator > 0
        ? `, ${plan.skippedNarrator} skipped (narrator)`
        : ""),
  );

  for (const d of plan.decisions) {
    if (d.decision !== "describe") {
      console.log(`[voice-desc] ${formatVoiceDecision(d)}`);
    }
  }

  const toDescribe = plan.decisions.filter((d) => d.decision === "describe");
  let processed = 0;
  for (const d of toDescribe) {
    const list = d.snippets.map((s, idx) => `${idx + 1}. ${s}`).join("\n");

    const prompt = `Consolidate these voice description snippets into a single, concise voice description suitable for ElevenLabs voice design. Focus on tone, pitch, accent, and speaking style. Keep it under 100 words.

Character: "${d.resolvedName}"

Snippets:
${list}

Return ONLY the consolidated description as plain text — no JSON, no markdown.`;

    const textPart = createPartFromText(prompt);
    const response = await gemini.models.generateContent({
      model: GEMINI_MEDIUM,
      contents: [textPart],
    });

    const text = response.text?.trim();
    if (!text) {
      throw new Error(`No Gemini response for ${d.characterId}`);
    }

    const appearanceId = d.appearanceId!;
    const { error: upErr } = await supabase
      .from("character_appearances")
      .upsert(
        {
          id: appearanceId,
          character_id: d.characterId,
          media_type: "voice_design",
          voice_description: text,
        },
        { onConflict: "id" },
      );

    if (upErr) throw new FatalError(upErr.message);

    console.log(
      `[voice-desc] ${formatVoiceDecision(d)} (wrote ${text.length} chars)`,
    );
    processed++;

    if (processed < toDescribe.length) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log(
    `[voice-desc] ${bookId}/${issueId}: consolidated ${processed} character(s)`,
  );
}

export async function cleanVoiceDescriptions(bookId: string, issueId: string) {
  "use step";
  console.log(
    `[clean-desc] ${bookId}/${issueId}: no-op (retired; descriptions live on character_appearances)`,
  );
}
