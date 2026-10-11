#!/usr/bin/env node
/**
 * Cue check for one issue, in two modes.
 *
 * Dry run (#840, the default): sends every speakable bubble (`ignored =
 * false`, `silent = false`) through the call the review editor's Regenerate
 * cues makes (`cueRequest`, with the bubble's `ocr_text`, saved speaker and
 * emotion) and prints a markdown table of the bubbles whose cues would
 * change. It writes nothing to the database, not even the `llm_calls`
 * ledger: the Gemini call goes straight to `ai.models.generateContent`, and
 * the token totals are printed instead.
 *
 *   LIVE_API_OK=1 pnpm recue-issue --book <id> --issue <id> [--limit N] [--out report.md]
 *
 * Apply (#844, `--apply`, paid, writes production rows): takes only the
 * speakable bubbles whose saved cues break a written rule (`reasons()` other
 * than "model would re-cue"), narrowed by `--only` to 8-character id
 * prefixes. It re-proposes each through the same call, logged to
 * `llm_calls` under step `recue-issue:apply`, and skips and lists a row
 * whose words differ or whose proposal equals its old cues. It prices the
 * re-render with `price()` and exits before any write when that exceeds
 * `--max-chars`. Then it writes every new cue (`text_with_cues`,
 * `needs_audio`, `updated_at`, only where the row's cues are still the ones
 * it read), and renders one at a time: a joined group with two or more
 * active members once through `renderGroupAudio`, every other row through
 * `renderBubbleAudio`. The render loop stops once the billed characters
 * reach `--max-chars`, or at the first render error. The report gains an
 * "Applied" table and the totals billed.
 *
 *   LIVE_API_OK=1 pnpm recue-issue --book <id> --issue <id> --apply --max-chars N [--only id8,id8] [--out report.md]
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { supabase } from "./lib/supabase.js";
import { groupLeadId, joinGroupText } from "~/lib/balloon-groups";
import {
  issueCast,
  loadBookCast,
  proposeCast,
  renderVoice,
  ROLE_IDS,
} from "~/lib/cast";
import { cueRequest, type CuePromptInput } from "~/lib/cue-rules";
import { isDryRun } from "~/lib/fakes/dry-run";
import { getGeminiClient } from "~/lib/gemini-client";
import { selectIssue } from "~/lib/issue-queries";
import { generateContentLogged, type LlmCallMeta } from "~/lib/llm-usage";
import {
  BubbleRenderError,
  renderBubbleAudio,
} from "~/lib/render-bubble-audio";
import { GroupRenderError, renderGroupAudio } from "~/lib/render-group-audio";
import { buildTtsRequest } from "~/lib/tts-request";
import { loadVoiceOverrides } from "~/lib/voice-overrides";

const POOL = 5;
const APPLY_STEP = "recue-issue:apply";
const RULE_FREE = "model would re-cue";

interface Row {
  id: string;
  page_number: number;
  ocr_text: string | null;
  text_with_cues: string | null;
  character_id: string | null;
  speaker: string | null;
  emotion: string | null;
  group_id: string | null;
}

type Result = { row: Row; proposal: string | null; error?: string };
type Changed = Result & { proposal: string };

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
  const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
  const ocr = row.ocr_text ?? "";
  const bare = stripTags(old);
  if (
    count(bare, /—/g) > count(ocr, /—/g) &&
    count(bare, /\.\.\.|…/g) < count(ocr, /\.\.\.|…/g)
  )
    out.push("— for ...");
  return out.length > 0 ? out.join(", ") : RULE_FREE;
}

/**
 * One cue call, retried once on an error or an empty reply. With `log` the
 * call goes through `generateContentLogged`, so it lands in `llm_calls`.
 */
async function cue(input: CuePromptInput, log?: LlmCallMeta): Promise<string> {
  const ai = getGeminiClient();
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = log
        ? await generateContentLogged(ai, cueRequest(input), log)
        : await ai.models.generateContent(cueRequest(input));
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
 * The speaker ids the review editor offers, as its loader builds them: the
 * issue's cast (`proposeCast` when the issue has no castlist rows), then the
 * three roles unless the cast removed one; narrator always stays.
 */
async function editorSpeakerIds(
  bookId: string,
  issueId: string,
): Promise<Set<string>> {
  const book = await loadBookCast(supabase, bookId);
  const issueRows = book.rows.filter((r) => r.issue_id === issueId);
  const ids: string[] =
    issueRows.length > 0
      ? issueCast(book, issueId).flatMap((r) =>
          r.character_id ? [r.character_id] : [],
        )
      : (await proposeCast(supabase, bookId, issueId)).members.map((m) => m.id);
  const removed = new Set(
    issueRows.flatMap((r) =>
      !r.in_issue && r.character_id ? [r.character_id] : [],
    ),
  );
  for (const id of ROLE_IDS)
    if (id === "narrator" || !removed.has(id)) ids.push(id);
  return new Set(ids);
}

/**
 * The editor sends `ocr_text` as the text, the cast id when the editor's
 * speaker list holds it (else the raw speaker label, as `toBubble` does) and
 * the emotion, as saved (Workbench `saveFirst`).
 */
async function check(
  row: Row,
  inCast: Set<string>,
  log?: LlmCallMeta,
): Promise<Result> {
  if (!row.ocr_text?.trim())
    return { row, proposal: null, error: "Empty text" };
  try {
    const proposal = await cue(
      {
        text: row.ocr_text,
        emotion: row.emotion ?? "",
        speaker:
          row.character_id && inCast.has(row.character_id)
            ? row.character_id
            : row.speaker,
      },
      log,
    );
    return { row, proposal };
  } catch (e) {
    return { row, proposal: null, error: (e as Error).message };
  }
}

/** `check` on every row, `POOL` at a time. */
async function checkAll(
  rows: Row[],
  inCast: Set<string>,
  log?: LlmCallMeta,
): Promise<Result[]> {
  const results: Result[] = [];
  for (let i = 0; i < rows.length; i += POOL)
    results.push(
      ...(await Promise.all(
        rows.slice(i, i + POOL).map((r) => check(r, inCast, log)),
      )),
    );
  return results;
}

/**
 * Splits the replies: failed (no proposal), flagged (the words must match
 * the input and, when there are old cues, the old line), kept (the rest)
 * and changed (kept, with a proposal other than the old cues).
 */
function sortResults(results: Result[]) {
  const failed = results.filter((r) => r.proposal === null);
  const ok = results.filter((r): r is Changed => r.proposal !== null);
  const flagged = ok.filter((r) => {
    const said = words(r.proposal).join(" ");
    const old = r.row.text_with_cues;
    return (
      said !== words(r.row.ocr_text ?? "").join(" ") ||
      (old !== null && said !== words(old).join(" "))
    );
  });
  const kept = ok.filter((r) => !flagged.includes(r));
  const changed = kept.filter(
    (r) =>
      r.row.text_with_cues === null ||
      squash(r.proposal) !== squash(r.row.text_with_cues),
  );
  return { failed, flagged, kept, changed };
}

type Sibling = {
  id: string;
  sort_order: number;
  character_id: string | null;
  text_with_cues: string | null;
  ocr_text: string | null;
  ignored: boolean;
  silent: boolean;
};

/**
 * The ElevenLabs characters a re-render of the changed rows sends, voice
 * prefix included. A bubble in a joined group (#451) with two or more active
 * members re-renders the whole group once, as `renderGroupAudio` does: the
 * active members in sort order, changed ones with their new cues, joined by
 * `joinGroupText`, in the lead's voice. That render refuses a group holding
 * an ignored or silent row, so such a group costs nothing and is counted.
 * Its other refusals (members split across panels or speakers, a member
 * with no text) are not checked here, so the total is an upper bound.
 */
async function price(bookId: string, issueId: string, changed: Changed[]) {
  const fresh = new Map(changed.map((r) => [r.row.id, r.proposal]));
  const groups = new Map<string, Sibling[]>();
  for (const g of new Set(changed.flatMap((r) => r.row.group_id ?? []))) {
    const { data, error } = await supabase
      .from("bubbles")
      .select(
        "id, sort_order, character_id, text_with_cues, ocr_text, ignored, silent",
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("group_id", g)
      .order("sort_order")
      .order("id");
    if (error) throw new Error(`group ${g}: ${error.message}`);
    groups.set(g, (data ?? []) as Sibling[]);
  }

  const units: { characterId: string | null; text: string }[] = [];
  const priced = new Set<string>();
  let grouped = 0;
  let refused = 0;
  for (const r of changed) {
    const g = r.row.group_id;
    const rows = g ? (groups.get(g) ?? []) : [];
    const active = rows.filter((m) => !m.ignored && !m.silent);
    if (!g || active.length < 2) {
      units.push({ characterId: r.row.character_id, text: r.proposal });
      continue;
    }
    grouped++;
    if (priced.has(g)) continue;
    priced.add(g);
    if (active.length < rows.length) {
      refused++;
      continue;
    }
    const lead = groupLeadId(
      active.map((m) => ({ id: m.id, sortOrder: m.sort_order })),
    );
    units.push({
      characterId: active.find((m) => m.id === lead)!.character_id,
      text: joinGroupText(
        active.map((m) =>
          (fresh.get(m.id) ?? m.text_with_cues ?? m.ocr_text ?? "").trim(),
        ),
      ),
    });
  }

  const book = await loadBookCast(supabase, bookId);
  const voices = units.map((u) => renderVoice(book, u.characterId, issueId));
  const overrides = await loadVoiceOverrides(
    supabase,
    voices.flatMap((v) => (v.ok ? [v.elevenLabsId] : [])),
  );
  const characters = units.reduce((sum, u, i) => {
    const v = voices[i]!;
    const override = v.ok ? overrides.get(v.elevenLabsId) : undefined;
    return (
      sum + buildTtsRequest({ text: u.text, voiceId: "", override }).text.length
    );
  }, 0);
  const noVoice = voices.filter((v) => !v.ok).length;
  return { characters, renders: units.length, grouped, refused, noVoice };
}

const cell = (s: string | null) =>
  s === null ? "_(null)_" : squash(s).replace(/\|/g, "\\|");

const line = (r: Result, ...mid: string[]) =>
  `| ${[r.row.page_number, cell(r.row.character_id ?? r.row.speaker), ...mid, r.row.id.slice(0, 8)].join(" | ")} |`;

/** A markdown table; an empty one is left out unless `always`. */
const table = (
  title: string,
  mid: string[],
  body: string[],
  always = false,
) => {
  const head = ["page", "speaker", ...mid, "bubble"];
  return body.length === 0 && !always
    ? []
    : ["", `## ${title}`, "", `| ${head.join(" | ")} |`].concat(
        `|${head.map(() => "---").join("|")}|`,
        body,
      );
};

const tokenLine = () =>
  `- Gemini tokens: ${tokens.prompt} prompt, ${tokens.output} output, ${tokens.thinking} thinking, over ${tokens.calls} calls`;

/** The flagged and failed tables, the same in both modes. */
function skippedTables(flagged: Changed[], failed: Result[]): string[] {
  return [
    ...table(
      "Flagged, left out (words differ)",
      ["old cues", "input", "proposal"],
      flagged.map((r) =>
        line(
          r,
          cell(r.row.text_with_cues),
          cell(r.row.ocr_text),
          cell(r.proposal),
        ),
      ),
    ),
    ...table(
      "Empty or failed",
      ["error"],
      failed.map((r) => line(r, cell(r.error ?? ""))),
    ),
  ];
}

/**
 * The reader pages a write touched. `revalidateReaderPages` needs the
 * Next.js runtime, so a script reaches it through the app's /api/revalidate
 * route, as `backfill-balloon-groups.ts` and `apply-fixes.ts` do.
 */
async function revalidate(bookId: string, issueId: string, pages: number[]) {
  if (pages.length === 0) return;
  const list = [...new Set(pages)].sort((a, b) => a - b).join(", ");
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (baseUrl && secret) {
    const res = await fetch(`${baseUrl}/api/revalidate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-revalidate-secret": secret,
      },
      body: JSON.stringify({ bookId, issueId }),
    });
    console.log(
      res.ok
        ? `Reader pages revalidated (pages ${list} changed).`
        : `Revalidate failed: ${res.status} ${await res.text()}`,
    );
  } else {
    console.log(
      `Pages ${list} changed. NEXT_PUBLIC_BASE_URL is not set, so nothing was revalidated. Run:\n` +
        `  curl -X POST <app-url>/api/revalidate -H 'content-type: application/json' -H "x-revalidate-secret: $REVALIDATE_SECRET" -d '{"bookId":"${bookId}","issueId":"${issueId}"}'`,
    );
  }
}

/**
 * `--apply`: re-cue the rule-backed rows, write the new cues, then render.
 * Returns the report lines. Throws before any write when the price is over
 * `maxChars`.
 */
async function apply(
  bookId: string,
  issueId: string,
  targets: Row[],
  inCast: Set<string>,
  maxChars: number,
): Promise<string[]> {
  const log: LlmCallMeta = { step: APPLY_STEP, bookId, issueId };
  const results = await checkAll(targets, inCast, log);
  const { failed, flagged, kept, changed } = sortResults(results);
  const unchanged = kept.filter((r) => !changed.includes(r));

  const cost = await price(bookId, issueId, changed);
  if (cost.characters > maxChars)
    throw new Error(
      `Priced at most ${cost.characters} ElevenLabs characters over ${cost.renders} renders for ${changed.length} changed rows, above --max-chars ${maxChars}. No cues were written and nothing was rendered; the Gemini calls are in llm_calls.\n` +
        `(${flagged.length} flagged, ${unchanged.length} unchanged, ${failed.length} failed replies)\n` +
        tokenLine(),
    );

  const book = await loadBookCast(supabase, bookId);

  // Write every new cue first. A row an editor changed since the read (its
  // cues or speaker, or it went ignored or silent) is left alone, since the
  // single render below uses the row as read.
  const outcome = new Map<string, string>();
  const written: Changed[] = [];
  for (const r of changed) {
    let q = supabase
      .from("bubbles")
      .update({
        text_with_cues: r.proposal,
        needs_audio: true,
        updated_at: new Date().toISOString(),
      })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("id", r.row.id)
      .eq("ignored", false)
      .eq("silent", false);
    for (const col of [
      "text_with_cues",
      "character_id",
      "speaker",
      "group_id",
    ] as const) {
      const v = r.row[col];
      q = v === null ? q.is(col, null) : q.eq(col, v);
    }
    const { data, error } = await q.select("id");
    if (error) outcome.set(r.row.id, `not written: ${error.message}`);
    else if (!data?.length)
      outcome.set(r.row.id, "not written: the row changed since the read");
    else written.push(r);
  }

  // A sibling whose write failed renders with its old cues, so price what
  // was written before any render. A failed read here must still print the
  // report, which lists the written rows left to render.
  let stop: string | null = null;
  try {
    const repriced = await price(bookId, issueId, written);
    if (repriced.characters > maxChars)
      stop = `not started: the written rows price at ${repriced.characters} characters, above --max-chars ${maxChars}`;
  } catch (e) {
    stop = `not started: re-pricing failed (${(e as Error).message})`;
  }

  // Then render, one at a time.
  const groupOutcome = new Map<string, string>();
  let billed = 0;
  let renders = 0;
  let stalePaid = 0;
  for (const r of written) {
    const id = r.row.id;
    const g = r.row.group_id;
    const done = g ? groupOutcome.get(g) : undefined;
    if (done) {
      outcome.set(id, done);
      continue;
    }
    if (!stop && billed >= maxChars) stop = `--max-chars ${maxChars} reached`;
    if (stop) {
      outcome.set(id, `not rendered: ${stop}`);
      continue;
    }
    try {
      if (g) {
        const res = await renderGroupAudio({
          client: supabase,
          bookId,
          issueId,
          groupId: g,
          step: APPLY_STEP,
          book,
        });
        let text: string | null = null;
        if ("rendered" in res) {
          billed += res.characters;
          renders++;
          text = `group of ${res.memberIds.length} rendered, ${res.characters} chars, ${res.path}`;
        } else if (res.skipped === "stale-group") {
          stalePaid++;
          text = `group skipped: stale-group, paid and not stored (${res.detail})`;
        } else if (res.skipped !== "single") {
          text = `group skipped: ${res.skipped}${"memberId" in res ? ` (${res.memberId})` : ""}${"detail" in res ? ` (${res.detail})` : ""}`;
        }
        if (text) {
          groupOutcome.set(g, text);
          outcome.set(id, text);
          continue;
        }
      }
      const res = await renderBubbleAudio({
        client: supabase,
        bookId,
        issueId,
        bubble: { ...r.row, text_with_cues: r.proposal },
        step: APPLY_STEP,
        book,
      });
      if ("rendered" in res) {
        billed += res.characters;
        renders++;
        outcome.set(id, `rendered, ${res.characters} chars, ${res.path}`);
      } else {
        outcome.set(
          id,
          `skipped: ${res.skipped}${"detail" in res ? ` (${res.detail})` : ""}`,
        );
      }
    } catch (e) {
      const stage =
        e instanceof GroupRenderError || e instanceof BubbleRenderError
          ? ` at ${e.stage}`
          : "";
      const text = `render failed${stage}: ${(e as Error).message}`;
      outcome.set(id, text);
      if (g) groupOutcome.set(g, text);
      stop = "stopped after a render error";
    }
  }

  // Best effort: the writes landed, so a failed refresh must not lose the report.
  await revalidate(
    bookId,
    issueId,
    written.map((r) => r.row.page_number),
  ).catch((e: Error) => console.log(`Revalidate failed: ${e.message}`));

  return [
    `# Cue apply: ${bookId} ${issueId}`,
    "",
    `- Rule-backed bubbles re-proposed: ${targets.length}`,
    `- Cues written: ${written.length} of ${changed.length} changed`,
    `- Skipped, proposal equals the old cues: ${unchanged.length}`,
    `- Flagged, words differ, left out: ${flagged.length}`,
    `- Empty or failed replies: ${failed.length}`,
    `- Priced before writing: at most ${cost.characters} ElevenLabs characters over ${cost.renders} renders (--max-chars ${maxChars})`,
    `- ElevenLabs characters in stored renders: ${billed} over ${renders} renders (a paid call whose upload or switch failed is in llm_calls, not here)` +
      (stalePaid
        ? ` (plus ${stalePaid} stale-group renders that were paid and not stored, not in this total)`
        : "") +
      (stop ? `; render loop ${stop}` : ""),
    tokenLine(),
    ...table(
      "Applied",
      ["old cues", "new cues", "reason", "render result"],
      changed.map((r) =>
        line(
          r,
          cell(r.row.text_with_cues),
          cell(r.proposal),
          reasons(r.row),
          cell(outcome.get(r.row.id) ?? ""),
        ),
      ),
      true,
    ),
    ...table(
      "Skipped, proposal equals the old cues",
      ["old cues"],
      unchanged.map((r) => line(r, cell(r.row.text_with_cues))),
    ),
    ...skippedTables(flagged, failed),
  ];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      book: { type: "string" },
      issue: { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
      apply: { type: "boolean" },
      "max-chars": { type: "string" },
      only: { type: "string" },
    },
  });
  const { book: bookId, issue: issueId } = values;
  if (!bookId || !issueId) {
    throw new Error(
      "Usage: pnpm recue-issue --book <id> --issue <id> [--limit N] [--out path] [--apply --max-chars N [--only id8,id8]]",
    );
  }
  const limit = values.limit ? Number(values.limit) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0))
    throw new Error(`--limit must be a positive integer, got ${values.limit}`);
  const maxChars = Number(values["max-chars"]);
  if (values.apply) {
    if (!(Number.isInteger(maxChars) && maxChars > 0))
      throw new Error(
        `--apply needs --max-chars N, a positive integer cap on the ElevenLabs characters it may bill${values["max-chars"] ? `; got ${values["max-chars"]}` : ""}`,
      );
    if (isDryRun())
      throw new Error(
        "DRY_RUN is set, so --apply would store silent audio on a real book. Unset it.",
      );
  } else if (values["max-chars"] !== undefined || values.only !== undefined) {
    throw new Error("--max-chars and --only go with --apply");
  }

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
      "id, page_number, ocr_text, text_with_cues, character_id, speaker, emotion, group_id",
      { count: limit ? undefined : "exact" },
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("ignored", false)
    .eq("silent", false)
    .order("page_number")
    .order("sort_order");
  if (limit) q = q.limit(limit);
  const { data, error, count } = await q;
  if (error) throw new Error(`bubbles read: ${error.message}`);
  const rows = (data ?? []) as Row[];
  // A read the API capped would leave bubbles out without saying so.
  if (count !== null && count > rows.length)
    throw new Error(`bubbles read: got ${rows.length} of ${count} rows`);

  let lines: string[];
  if (values.apply) {
    let targets = rows.filter((r) => reasons(r) !== RULE_FREE);
    if (values.only !== undefined) {
      const only = values.only
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const missing = only.filter(
        (p) => !targets.some((r) => r.id.startsWith(p)),
      );
      if (only.length === 0 || missing.length > 0)
        throw new Error(
          `--only: ${missing.length ? `no rule-backed bubble starts with ${missing.join(", ")}` : "no ids given"}`,
        );
      targets = targets.filter((r) => only.some((p) => r.id.startsWith(p)));
    }
    const inCast = await editorSpeakerIds(bookId, issueId);
    lines = await apply(bookId, issueId, targets, inCast, maxChars);
  } else {
    const inCast = await editorSpeakerIds(bookId, issueId);
    const results = await checkAll(rows, inCast);
    const { failed, flagged, kept, changed } = sortResults(results);

    const cost = await price(bookId, issueId, changed);

    lines = [
      `# Cue check: ${bookId} ${issueId}`,
      "",
      `- Bubbles checked: ${rows.length}${limit ? ` (--limit ${limit})` : ""}`,
      `- Changed: ${changed.length}`,
      `- Unchanged: ${kept.length - changed.length}`,
      `- Flagged, words differ, left out: ${flagged.length}`,
      `- Empty or failed replies: ${failed.length}`,
      `- ElevenLabs characters to re-render the changed rows: at most ${cost.characters} over ${cost.renders} renders` +
        ` (${cost.grouped} changed rows in joined groups, each group priced once` +
        (cost.refused
          ? `; ${cost.refused} groups left out, the render refuses a group with an ignored or silent row`
          : "") +
        (cost.noVoice
          ? `; ${cost.noVoice} renders with no playable voice, counted without a prefix`
          : "") +
        ")",
      tokenLine(),
      ...table(
        "Changed",
        ["old cues", "new cues", "reason"],
        changed.map((r) =>
          line(r, cell(r.row.text_with_cues), cell(r.proposal), reasons(r.row)),
        ),
        true,
      ),
      ...skippedTables(flagged, failed),
    ];
  }
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
