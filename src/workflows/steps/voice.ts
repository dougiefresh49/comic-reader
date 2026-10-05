import { createPartFromText } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { slugify } from "~/lib/character-id";
import type { generateContentLogged as GenerateContentLogged } from "~/lib/llm-usage";
import { GEMINI_MEDIUM } from "~/lib/models";
import type { Database } from "~/types/database";

export type VoiceBubbleSnippet = {
  speaker: string;
  voice_description: string;
  ignored?: boolean | null;
  /** `bubbles.character_id`, the group key (#351); a bubble without one is in no group (#429). */
  character_id?: string | null;
};

export type VoiceDescriptionDecisionKind =
  | "skip_narrator"
  | "skip_ready"
  | "skip_has_description"
  | "skip_unresolved"
  | "skip_has_voice"
  | "describe";

export type VoiceCharacterGroup = {
  characterId: string;
  /**
   * The first raw speaker string in sorted order.
   */
  resolvedName: string;
  /** Raw speaker strings of this character's bubbles, sorted. */
  speakers: string[];
  snippets: string[];
};

export type VoiceDescriptionDecision = {
  characterId: string;
  /** The stable raw-speaker label. */
  resolvedName: string;
  /** Raw speaker strings of this character's bubbles. */
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
  skippedHasVoice: number;
  toDescribe: number;
};

export type PlanVoiceDescriptionsInput = {
  /** Pre-grouped by character id (from groupVoiceBubblesByCharacter). */
  groups: VoiceCharacterGroup[];
  readyCharacterIds: ReadonlySet<string>;
  existingCharacterIds: ReadonlySet<string>;
  /** Map of `<id>-voice-design` appearance id → voice_description (may be null). */
  designDescriptions: ReadonlyMap<string, string | null>;
  /**
   * When set, only these characters are described: a speaker with a design
   * request or with no voice (#351). Others are `skip_has_voice`.
   */
  eligibleCharacterIds?: ReadonlySet<string>;
  /** Characters with a design request; a ready voice does not skip them. */
  designRequestedIds?: ReadonlySet<string>;
};

/**
 * Group non-ignored bubble voice snippets by `bubbles.character_id`. A bubble
 * with no `character_id` is unassigned and joins no group: its speaker text
 * is a label only, never a key (#429). Label: the first raw speaker string
 * in sorted order.
 */
export function groupVoiceBubblesByCharacter(
  bubbles: VoiceBubbleSnippet[],
): VoiceCharacterGroup[] {
  const byCharacter = new Map<
    string,
    { speakers: Set<string>; snippets: string[] }
  >();
  for (const bubble of bubbles) {
    if (bubble.ignored) continue;
    const speaker = bubble.speaker?.trim();
    const desc = bubble.voice_description?.trim();
    const characterId = bubble.character_id?.trim();
    if (!speaker || !desc || !characterId) continue;
    let acc = byCharacter.get(characterId);
    if (!acc) {
      acc = { speakers: new Set(), snippets: [] };
      byCharacter.set(characterId, acc);
    }
    acc.speakers.add(speaker);
    acc.snippets.push(desc);
  }
  return [...byCharacter.keys()].sort().map((characterId) => {
    const acc = byCharacter.get(characterId)!;
    const speakers = [...acc.speakers].sort();
    return {
      characterId,
      resolvedName: speakers[0]!,
      speakers,
      snippets: acc.snippets,
    };
  });
}

/**
 * Pure plan: decide skip vs describe for each pre-grouped character. No I/O.
 */
export function planVoiceDescriptions(
  input: PlanVoiceDescriptionsInput,
): VoiceDescriptionPlan {
  const decisions: VoiceDescriptionDecision[] = [];
  let skippedReady = 0;
  let skippedNarrator = 0;
  let skippedHasDescription = 0;
  let skippedUnresolved = 0;
  let skippedHasVoice = 0;
  let toDescribe = 0;

  for (const group of input.groups) {
    const { characterId } = group;
    const appearanceId = `${characterId}-voice-design`;
    const base = {
      characterId,
      resolvedName: group.resolvedName,
      speakers: group.speakers,
      snippetCount: group.snippets.length,
      snippets: group.snippets,
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

    if (
      input.eligibleCharacterIds &&
      !input.eligibleCharacterIds.has(characterId)
    ) {
      decisions.push({
        ...base,
        decision: "skip_has_voice",
        appearanceId: null,
      });
      skippedHasVoice++;
      continue;
    }

    if (
      input.readyCharacterIds.has(characterId) &&
      !input.designRequestedIds?.has(characterId)
    ) {
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
    skippedHasVoice,
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
    case "skip_has_voice":
      return `${label}: skip has a voice and no design request`;
    case "describe":
      return `${label}: describe → ${d.appearanceId}`;
  }
}

/**
 * Who `generate-voice-descriptions` may describe (#351): a speaker with an
 * open design request, or one with no voice (#429). A character whose own
 * castlist row in this issue is removed or "no audio" never is; one whose
 * chain stops only through its `form_of` target is, with a design request.
 * `ids` are the groups' character ids, matched to castlist rows by
 * `character_id`.
 */
export async function loadDescriptionEligibility(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
  ids: string[],
): Promise<{ eligible: Set<string>; designRequested: Set<string> }> {
  const { castRow, loadBookCast, readVoiceRequests, renderVoice, voiceFor } =
    await import("~/lib/cast");
  const [book, requests] = await Promise.all([
    loadBookCast(client, bookId),
    readVoiceRequests(client, bookId, issueId),
  ]);
  const designRequested = new Set(
    requests
      .filter(
        (r) =>
          r.action === "design" &&
          (r.status === "pending" || r.status === "in_progress"),
      )
      .map((r) => r.characterId),
  );
  const eligible = new Set<string>();
  for (const id of ids) {
    // Its own row removes or silences it here: a leftover request buys nothing.
    const own = castRow(book, id, issueId);
    if (own && (!own.in_issue || own.no_audio)) continue;
    if (designRequested.has(id)) {
      eligible.add(id);
      continue;
    }
    // A stop inherited through `form_of` skips it unless a design is requested.
    const found = renderVoice(book, id, issueId);
    if (
      !found.ok &&
      (found.reason === "removed" || found.reason === "no audio")
    )
      continue;
    if (!voiceFor(book, id, issueId)) eligible.add(id);
  }
  return { eligible, designRequested };
}

/**
 * SELECT-only loader for planVoiceDescriptions. Shared by the step and the
 * acceptance script so speaker resolution and the queries live in one place.
 */
export async function loadVoiceDescriptionPlanInput(
  client: SupabaseClient<Database>,
  bookId: string,
  issueId: string,
): Promise<PlanVoiceDescriptionsInput> {
  const { data: bubbleRows, error: bubbleErr } = await client
    .from("bubbles")
    .select("id, speaker, character_id, voice_description, ignored")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .not("voice_description", "is", null)
    .not("speaker", "is", null)
    .not("character_id", "is", null)
    .order("id");

  if (bubbleErr) throw new Error(bubbleErr.message);

  const bubbles: VoiceBubbleSnippet[] = [];
  for (const row of bubbleRows ?? []) {
    if (!row.speaker || !row.voice_description) continue;
    bubbles.push({
      speaker: row.speaker,
      voice_description: row.voice_description,
      ignored: row.ignored,
      character_id: row.character_id,
    });
  }

  const groups = groupVoiceBubblesByCharacter(bubbles);
  const resolvedIdList = groups.map((g) => g.characterId);

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

  const { eligible, designRequested } = await loadDescriptionEligibility(
    client,
    bookId,
    issueId,
    resolvedIdList,
  );

  return {
    groups,
    readyCharacterIds,
    existingCharacterIds,
    designDescriptions,
    eligibleCharacterIds: eligible,
    designRequestedIds: designRequested,
  };
}

type GenerateClient = Parameters<typeof GenerateContentLogged>[0];

export interface DescribeVoicesOptions {
  /** Describe only these character ids (`carryOut`'s one design). */
  only?: string[];
  /**
   * `generateContentLogged` from `~/lib/llm-usage`, passed in so this
   * module never imports it outside a step body (the workflow bundle
   * refuses its Node.js imports).
   */
  generate: typeof GenerateContentLogged;
}

/**
 * Plans the issue's voice descriptions and writes each one Gemini makes to
 * `<id>-voice-design` (one `GEMINI_MEDIUM` call per character, logged).
 * `opts.only` limits the writes to those character ids, for `carryOut`'s
 * design of a character with no stored description. Returns the ids
 * described.
 */
export async function describeVoices(
  client: SupabaseClient<Database>,
  gemini: GenerateClient,
  bookId: string,
  issueId: string,
  opts: DescribeVoicesOptions,
): Promise<{ plan: VoiceDescriptionPlan; described: string[] }> {
  const input = await loadVoiceDescriptionPlanInput(client, bookId, issueId);
  const plan = planVoiceDescriptions(input);

  console.log(
    `[voice-desc] ${bookId}/${issueId}: ${plan.characterCount} characters, ${plan.skippedReady} skipped (ready voice), ${plan.toDescribe} to describe` +
      (plan.skippedHasVoice > 0
        ? `, ${plan.skippedHasVoice} skipped (has a voice, no design request)`
        : "") +
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

  const only = opts.only ? new Set(opts.only) : null;
  const toDescribe = plan.decisions.filter(
    (d) => d.decision === "describe" && (!only || only.has(d.characterId)),
  );
  const described: string[] = [];
  for (const d of toDescribe) {
    const list = d.snippets.map((s, idx) => `${idx + 1}. ${s}`).join("\n");

    const prompt = `Consolidate these voice description snippets into a single, concise voice description suitable for ElevenLabs voice design. Focus on tone, pitch, accent, and speaking style. Keep it under 100 words.

Character: "${d.resolvedName}"

Snippets:
${list}

Return ONLY the consolidated description as plain text — no JSON, no markdown.`;

    const textPart = createPartFromText(prompt);
    const response = await opts.generate(
      gemini,
      { model: GEMINI_MEDIUM, contents: [textPart] },
      { step: "generate-voice-descriptions", bookId, issueId },
    );

    const text = response.text?.trim();
    if (!text) {
      throw new Error(`No Gemini response for ${d.characterId}`);
    }

    const appearanceId = d.appearanceId!;
    const { error: upErr } = await client.from("character_appearances").upsert(
      {
        id: appearanceId,
        character_id: d.characterId,
        media_type: "voice_design",
        voice_description: text,
      },
      { onConflict: "id" },
    );

    if (upErr) throw new Error(upErr.message);

    console.log(
      `[voice-desc] ${formatVoiceDecision(d)} (wrote ${text.length} chars)`,
    );
    described.push(d.characterId);

    if (described.length < toDescribe.length) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return { plan, described };
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
  const { getGeminiClient } = await import("~/lib/gemini-client");
  const { generateContentLogged } = await import("~/lib/llm-usage");

  let described: string[];
  try {
    ({ described } = await describeVoices(
      supabase,
      getGeminiClient(),
      bookId,
      issueId,
      { generate: generateContentLogged },
    ));
  } catch (e) {
    throw new FatalError(e instanceof Error ? e.message : String(e));
  }

  console.log(
    `[voice-desc] ${bookId}/${issueId}: consolidated ${described.length} character(s)`,
  );
}

export async function cleanVoiceDescriptions(bookId: string, issueId: string) {
  "use step";
  console.log(
    `[clean-desc] ${bookId}/${issueId}: no-op (retired; descriptions live on character_appearances)`,
  );
}
