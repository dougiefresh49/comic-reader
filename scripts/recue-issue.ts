#!/usr/bin/env node
/**
 * Dry-run cue check for one issue (#840): sends every speakable bubble
 * (`ignored = false`, `silent = false`) through the call the review editor's
 * Regenerate cues makes (`cueRequest`, with the bubble's `ocr_text`, saved
 * speaker and emotion) and prints a markdown table of the bubbles whose cues
 * would change. It writes nothing to the database, not even the `llm_calls`
 * ledger: the Gemini call goes straight to `ai.models.generateContent`, and
 * the token totals are printed instead.
 *
 *   LIVE_API_OK=1 pnpm recue-issue --book <id> --issue <id> [--limit N] [--out report.md]
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { supabase } from "./lib/supabase.js";
import { loadBookCast, renderVoice } from "~/lib/cast";
import { cueRequest, type CuePromptInput } from "~/lib/cue-rules";
import { getGeminiClient } from "~/lib/gemini-client";
import { selectIssue } from "~/lib/issue-queries";
import { buildTtsRequest } from "~/lib/tts-request";
import { loadVoiceOverrides } from "~/lib/voice-overrides";

const POOL = 5;

interface Row {
  id: string;
  page_number: number;
  ocr_text: string | null;
  text_with_cues: string | null;
  character_id: string | null;
  speaker: string | null;
  emotion: string | null;
}

type Result = { row: Row; proposal: string | null; error?: string };

const tokens = { calls: 0, prompt: 0, output: 0, thinking: 0 };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const stripTags = (s: string) => s.replace(/\[[^\]]*\]/g, " ");

/** Lowercase word tokens with tags removed: letters, digits and apostrophes. */
function words(s: string): string[] {
  return (
    stripTags(s)
      .replace(/[‘’]/g, "'")
      .toLowerCase()
      .match(/[\p{L}\p{N}']+/gu) ?? []
  );
}

/** The free rule checks on the old cues; "model would re-cue" when none fires. */
function reasons(row: Row): string {
  const old = row.text_with_cues;
  if (old === null) return "null cues";
  const out: string[] = [];
  if (/\]\s*\[/.test(old)) out.push("stacked tags");
  const caps = (stripTags(old).match(/[\p{L}']+/gu) ?? []).filter((w) => {
    const letters = w.replace(/'/g, "");
    return (
      letters.length >= 2 &&
      letters === letters.toUpperCase() &&
      letters !== letters.toLowerCase()
    );
  });
  if (caps.length > 1) out.push("all caps");
  if (old.includes("—") && /\.\.\.|…/.test(row.ocr_text ?? ""))
    out.push("— for ...");
  return out.length > 0 ? out.join(", ") : "model would re-cue";
}

/** One cue call, retried once on an error or an empty reply. */
async function cue(input: CuePromptInput): Promise<string> {
  const ai = getGeminiClient();
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ai.models.generateContent(cueRequest(input));
      tokens.calls++;
      tokens.prompt += res.usageMetadata?.promptTokenCount ?? 0;
      tokens.output += res.usageMetadata?.candidatesTokenCount ?? 0;
      tokens.thinking += res.usageMetadata?.thoughtsTokenCount ?? 0;
      const text = res.text?.trim() ?? "";
      if (text) return text;
      last = "Empty Gemini response";
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(last);
}

/**
 * The editor sends `ocr_text` as the text, the cast id (else the raw speaker
 * label) and the emotion, as saved (Workbench `saveFirst`).
 */
async function check(row: Row): Promise<Result> {
  if (!row.ocr_text?.trim())
    return { row, proposal: null, error: "Empty text" };
  try {
    const proposal = await cue({
      text: row.ocr_text,
      emotion: row.emotion ?? "",
      speaker: row.character_id ?? row.speaker,
    });
    return { row, proposal };
  } catch (e) {
    return { row, proposal: null, error: (e as Error).message };
  }
}

const cell = (s: string | null) =>
  s === null ? "_(null)_" : squash(s).replace(/\|/g, "\\|");

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      book: { type: "string" },
      issue: { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
    },
  });
  const { book: bookId, issue: issueId } = values;
  if (!bookId || !issueId) {
    throw new Error(
      "Usage: pnpm recue-issue --book <id> --issue <id> [--limit N] [--out path]",
    );
  }
  const limit = values.limit ? Number(values.limit) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0))
    throw new Error(`--limit must be a positive integer, got ${values.limit}`);

  const { data: issue, error: iErr } = await selectIssue(
    supabase,
    bookId,
    issueId,
    "id",
  ).maybeSingle();
  if (iErr || !issue)
    throw new Error(iErr?.message ?? `No issue ${issueId} in book ${bookId}.`);

  let q = supabase
    .from("bubbles")
    .select(
      "id, page_number, ocr_text, text_with_cues, character_id, speaker, emotion",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("ignored", false)
    .eq("silent", false)
    .order("page_number")
    .order("sort_order");
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw new Error(`bubbles read: ${error.message}`);
  const rows = (data ?? []) as Row[];

  const results: Result[] = [];
  for (let i = 0; i < rows.length; i += POOL)
    results.push(...(await Promise.all(rows.slice(i, i + POOL).map(check))));

  const failed = results.filter((r) => r.proposal === null);
  const ok = results.filter(
    (r): r is Result & { proposal: string } => r.proposal !== null,
  );
  const flagged = ok.filter(
    (r) =>
      words(r.proposal).join(" ") !== words(r.row.ocr_text ?? "").join(" "),
  );
  const kept = ok.filter((r) => !flagged.includes(r));
  const changed = kept.filter(
    (r) =>
      r.row.text_with_cues === null ||
      squash(r.proposal) !== squash(r.row.text_with_cues),
  );

  // ElevenLabs characters: the request text a render of the new line sends,
  // voice prefix included, priced per bubble.
  const book = await loadBookCast(supabase, bookId);
  const voices = changed.map((r) =>
    renderVoice(book, r.row.character_id, issueId),
  );
  const overrides = await loadVoiceOverrides(
    supabase,
    voices.flatMap((v) => (v.ok ? [v.elevenLabsId] : [])),
  );
  const credits = changed.reduce((sum, r, i) => {
    const v = voices[i]!;
    const override = v.ok ? overrides.get(v.elevenLabsId) : undefined;
    return (
      sum +
      buildTtsRequest({ text: r.proposal, voiceId: "", override }).text.length
    );
  }, 0);
  const noVoice = voices.filter((v) => !v.ok).length;

  const line = (r: Result, ...mid: string[]) =>
    `| ${[r.row.page_number, cell(r.row.character_id ?? r.row.speaker), ...mid, r.row.id.slice(0, 8)].join(" | ")} |`;
  const table = (title: string, mid: string[], body: string[]) => {
    const head = ["page", "speaker", ...mid, "bubble"];
    return body.length === 0 && title !== "Changed"
      ? []
      : ["", `## ${title}`, "", `| ${head.join(" | ")} |`].concat(
          `|${head.map(() => "---").join("|")}|`,
          body,
        );
  };
  const lines = [
    `# Cue check: ${bookId} ${issueId}`,
    "",
    `- Bubbles checked: ${rows.length}${limit ? ` (--limit ${limit})` : ""}`,
    `- Changed: ${changed.length}`,
    `- Unchanged: ${kept.length - changed.length}`,
    `- Flagged, words differ, left out: ${flagged.length}`,
    `- Empty or failed replies: ${failed.length}`,
    `- ElevenLabs characters to re-render the changed rows: ${credits}` +
      (noVoice ? ` (${noVoice} with no playable voice, counted bare)` : ""),
    `- Gemini tokens: ${tokens.prompt} prompt, ${tokens.output} output, ${tokens.thinking} thinking, over ${tokens.calls} calls`,
    ...table(
      "Changed",
      ["old cues", "new cues", "reason"],
      changed.map((r) =>
        line(r, cell(r.row.text_with_cues), cell(r.proposal), reasons(r.row)),
      ),
    ),
    ...table(
      "Flagged, left out (words differ)",
      ["input", "proposal"],
      flagged.map((r) => line(r, cell(r.row.ocr_text), cell(r.proposal))),
    ),
    ...table(
      "Empty or failed",
      ["error"],
      failed.map((r) => line(r, cell(r.error ?? ""))),
    ),
  ];
  const report = lines.join("\n") + "\n";
  if (values.out) {
    writeFileSync(values.out, report);
    console.log(`Wrote ${values.out}`);
  } else {
    process.stdout.write(report);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
