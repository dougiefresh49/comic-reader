/**
 * Bench get-context's speaker call on an OpenRouter free model (#321).
 *
 * Replays the speaker prompt from getContextPage (src/workflows/steps/vision.ts)
 * for the smoke pages (`smoke-test` / `issue-smoke`): the whole page image,
 * `buildContextPrompt` with the same book context and character list the step
 * builds, and each bubble's stored `ocr_text` in place of a fresh OCR call.
 * Each answer is set against the reviewed bubble on `tmnt-mmpr-iii` /
 * `issue-1` page 7 or 8 (matched by text) and against what GEMINI_HIGH wrote
 * on the smoke row.
 *
 * Read-only on Supabase (select and Storage download). The only network
 * call besides Supabase is OpenRouter, and only for model ids ending in `:free`.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/bench-speaker-model.ts \
 *     [--model google/gemma-4-31b-it:free] [--pages 1,2] [--limit n] \
 *     [--max-calls 40] [--out /tmp/comic-reader-briefs/bench-out]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildContextPrompt } from "~/lib/gemini-prompts";
import { selectIssue } from "~/lib/issue-queries";
import { pageStoragePath } from "~/lib/storage";
import { createTypedStepClient } from "~/workflows/step-utils";
import {
  buildContextUpdate,
  type ContextParsed,
} from "~/workflows/steps/vision-rows";

const BOOK = "smoke-test";
const ISSUE = "issue-smoke";
const TRUTH_BOOK = "tmnt-mmpr-iii";
const TRUTH_ISSUE = "issue-1";
/** Smoke page → the source page smoke-ingest copied it from. */
const TRUTH_PAGE: Record<number, number> = { 1: 7, 2: 8 };
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const BETWEEN_CALLS_MS = 4_000;
const RETRY_WAIT_MS = 20_000;
const MATCH_CHARS = 40;

// ── Args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const die = (msg: string): never => {
  console.error(`bench-speaker-model: ${msg}`);
  process.exit(1);
};
const intOpt = (name: string, fallback: number | undefined) => {
  const raw = opt(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) die(`${name} wants a positive integer`);
  return n;
};

const model = opt("--model") ?? "google/gemma-4-31b-it:free";
const pages = (opt("--pages") ?? "1,2").split(",").map((p) => Number(p));
const limit = intOpt("--limit", undefined);
const maxCalls = intOpt("--max-calls", 40)!;
const outDir = opt("--out") ?? "/tmp/comic-reader-briefs/bench-out";

if (!model.endsWith(":free")) {
  die(`refusing model "${model}": only ids ending in ":free" are allowed`);
}
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) die("OPENROUTER_API_KEY is not set in .env");
for (const p of pages) {
  if (!(p in TRUTH_PAGE)) die(`--pages takes 1 and/or 2, got "${p}"`);
}

// ── Types ───────────────────────────────────────────────────────────────
type Box = { x: number; y: number; width: number; height: number };
type Triple = {
  speaker: string | null;
  emotion: string | null;
  type: string | null;
};
type Row = {
  page: number;
  sortOrder: number | null;
  bubbleId: string;
  text: string;
  truth: Triple | null;
  geminiHigh: Triple;
  bench: (Triple & { textWithCues: string | null }) | null;
  parsed: boolean;
  rawReply: string | null;
  latencyMs: number | null;
  usage: unknown;
};

const supabase = await createTypedStepClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function must<T>(
  res: { data: T | null; error: { message: string } | null },
  what: string,
): T {
  if (res.error) die(`${what}: ${res.error.message}`);
  return res.data as T;
}

/** Uppercase, collapse whitespace, first 40 characters (the brief's rule). */
const textKey = (s: string | null) =>
  (s ?? "").toUpperCase().replace(/\s+/g, " ").trim().slice(0, MATCH_CHARS);

/** Plain speaker comparison: lowercase, strip non-alphanumerics. */
const plain = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// ── Book context, as getContextPage builds it ───────────────────────────
async function loadBookContext(): Promise<string> {
  const [bookRes, issueRes] = await Promise.all([
    supabase.from("books").select("name, franchises").eq("id", BOOK).single(),
    selectIssue(
      supabase,
      BOOK,
      ISSUE,
      "wiki_summary, wiki_appearances",
    ).single(),
  ]);
  const bookRow = must(bookRes, "books read");
  const issueRow = must(issueRes, "issues read");
  const parts: string[] = [];
  if (bookRow) {
    if (bookRow.name) parts.push(`Book: ${bookRow.name}`);
    if (bookRow.franchises?.length)
      parts.push(`Franchises: ${bookRow.franchises.join(", ")}`);
  }
  if (issueRow?.wiki_summary) {
    parts.push(`\nIssue Synopsis:\n${issueRow.wiki_summary}`);
  }
  if (issueRow?.wiki_appearances) {
    type AppEntry = { name: string; qualifier?: string };
    const appearances = issueRow.wiki_appearances as AppEntry[];
    const names = appearances.map((a) =>
      a.qualifier ? `${a.name} (${a.qualifier})` : a.name,
    );
    parts.push(`\nKnown Characters in this issue:\n${names.join(", ")}`);
  }
  parts.push(
    "Use your knowledge of comics and pop culture to identify characters by their proper canonical names where possible.",
  );
  return parts.join("\n");
}

/** Face-detection names for the page, as getContextPage derives them. */
async function loadPageCharNames(page: number): Promise<string[]> {
  const panels = must(
    await supabase
      .from("panels")
      .select("id, page_number")
      .eq("book_id", BOOK)
      .eq("issue_id", ISSUE)
      .eq("page_number", page),
    "panels read",
  );
  const names: string[] = [];
  if (!panels || panels.length === 0) return names;
  const detections = must(
    await supabase
      .from("panel_character_detections")
      .select("character_id")
      .in(
        "panel_id",
        panels.map((p) => p.id),
      ),
    "panel_character_detections read",
  );
  for (const d of detections ?? []) {
    if (d.character_id == null) continue;
    const name = d.character_id.replace(/-/g, " ");
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

async function loadTruth(page: number) {
  const rows = must(
    await supabase
      .from("bubbles")
      .select("ocr_text, text_with_cues, speaker, emotion, type")
      .eq("book_id", TRUTH_BOOK)
      .eq("issue_id", TRUTH_ISSUE)
      .eq("page_number", TRUTH_PAGE[page]!)
      .or("ignored.is.null,ignored.eq.false"),
    "truth bubbles read",
  );
  return (rows ?? []).map((r) => ({
    key: textKey(r.ocr_text ?? r.text_with_cues),
    triple: { speaker: r.speaker, emotion: r.emotion, type: r.type },
  }));
}

// ── OpenRouter ──────────────────────────────────────────────────────────
let calls = 0;
type CallResult =
  | { kind: "ok"; body: OpenRouterBody; latencyMs: number }
  | { kind: "error"; detail: string }
  | { kind: "stop"; detail: string };
type OpenRouterBody = {
  choices?: { message?: { content?: string | null } }[];
  usage?: unknown;
};

async function postOnce(imageUrl: string, prompt: string) {
  calls++;
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: imageUrl } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });
    const text = await res.text();
    return { status: res.status, text, latencyMs: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 0, text: `fetch failed: ${msg}`, latencyMs: 0 };
  }
}

const retryable = (status: number) =>
  status === 0 || status === 429 || status >= 500;

/** One request, one retry after 20 s on 429/5xx, never past --max-calls. */
async function callModel(imageUrl: string, prompt: string) {
  let first: Awaited<ReturnType<typeof postOnce>> | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (calls >= maxCalls) {
      return {
        kind: "stop",
        detail:
          `--max-calls ${maxCalls} reached` +
          (first ? ` after HTTP ${first.status}: ${first.text}` : ""),
      } satisfies CallResult;
    }
    if (attempt === 1) {
      console.log(`  HTTP ${first!.status}, retrying in 20 s`);
      await sleep(RETRY_WAIT_MS);
    }
    const r = await postOnce(imageUrl, prompt);
    if (r.status >= 200 && r.status < 300) {
      try {
        const body = JSON.parse(r.text) as OpenRouterBody;
        return { kind: "ok", body, latencyMs: r.latencyMs } as CallResult;
      } catch {
        return {
          kind: "error",
          detail: `HTTP ${r.status}, body is not JSON: ${r.text.slice(0, 500)}`,
        } as CallResult;
      }
    }
    if (!retryable(r.status)) {
      // A 4xx other than 429 (an image the route rejects, a bad id): stop.
      return {
        kind: "stop",
        detail: `HTTP ${r.status}: ${r.text}`,
      } as CallResult;
    }
    if (first?.status === 429 && r.status === 429) {
      return {
        kind: "stop",
        detail: `second consecutive 429: ${r.text}`,
      } as CallResult;
    }
    first = r;
  }
  return {
    kind: "error",
    detail: `HTTP ${first!.status} twice: ${first!.text.slice(0, 500)}`,
  } as CallResult;
}

// ── Output ──────────────────────────────────────────────────────────────
const cell = (s: string | number | boolean | null | undefined) =>
  String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();

function speakerVerdict(row: Row, t: Triple | null): string {
  if (!row.truth) return "no truth";
  if (!t) return "no answer";
  return plain(t.speaker) === plain(row.truth.speaker) ? "match" : "differs";
}

function writeOutputs(rows: Row[], stopReason: string | null) {
  mkdirSync(outDir, { recursive: true });
  const slug = model.replace(/[^a-zA-Z0-9]+/g, "-");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(outDir, `${slug}-${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify(rows, null, 2));

  const withTruth = rows.filter((r) => r.truth);
  const gemMatches = withTruth.filter(
    (r) => speakerVerdict(r, r.geminiHigh) === "match",
  ).length;
  const benchMatches = withTruth.filter(
    (r) => speakerVerdict(r, r.bench) === "match",
  ).length;
  const tokens = (u: unknown) => {
    const x = u as {
      prompt_tokens?: number;
      completion_tokens?: number;
    } | null;
    return x ? `${x.prompt_tokens ?? "?"}/${x.completion_tokens ?? "?"}` : "";
  };

  const header = [
    "page",
    "sort",
    "bubble",
    "text",
    "truth speaker",
    "truth emotion",
    "truth type",
    "GEMINI_HIGH speaker",
    "GEMINI_HIGH emotion",
    "GEMINI_HIGH type",
    "bench speaker",
    "bench emotion",
    "bench type",
    "bench textWithCues",
    "parsed",
    "ms",
    "tokens in/out",
    "GEMINI_HIGH vs truth",
    "bench vs truth",
  ];
  const lines = [
    `# Speaker bench: ${model}`,
    "",
    `Smoke pages ${pages.join(", ")} (\`${BOOK}\` / \`${ISSUE}\`), truth from \`${TRUTH_BOOK}\` / \`${TRUTH_ISSUE}\`.`,
    "",
    `Totals: ${rows.length} bubbles sent, ${rows.filter((r) => r.parsed).length} replies parsed, ` +
      `speaker matches against truth: GEMINI_HIGH ${gemMatches}/${withTruth.length}, ` +
      `${model} ${benchMatches}/${withTruth.length}. OpenRouter requests: ${calls}.`,
    ...(stopReason ? ["", `Stopped early: ${stopReason}`] : []),
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (r) =>
        `| ${[
          r.page,
          r.sortOrder,
          r.bubbleId.slice(0, 8),
          cell(r.text),
          cell(r.truth?.speaker),
          cell(r.truth?.emotion),
          cell(r.truth?.type),
          cell(r.geminiHigh.speaker),
          cell(r.geminiHigh.emotion),
          cell(r.geminiHigh.type),
          cell(r.bench?.speaker),
          cell(r.bench?.emotion),
          cell(r.bench?.type),
          cell(r.bench?.textWithCues),
          r.parsed ? "yes" : "no",
          r.latencyMs ?? "",
          tokens(r.usage),
          speakerVerdict(r, r.geminiHigh),
          speakerVerdict(r, r.bench),
        ]
          .map(cell)
          .join(" | ")} |`,
    ),
    "",
  ];
  writeFileSync(`${base}.md`, lines.join("\n"));
  console.log(`\nwrote ${base}.json\nwrote ${base}.md`);
  console.log(lines[4]);
}

// ── Main ────────────────────────────────────────────────────────────────
const rows: Row[] = [];
let stopReason: string | null = null;
const bookContext = await loadBookContext();

pageLoop: for (const page of pages) {
  const blob = must(
    await supabase.storage
      .from("comic-pages")
      .download(pageStoragePath(BOOK, ISSUE, page)),
    `comic-pages download for page ${page}`,
  );
  const imageUrl = `data:image/webp;base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`;
  const pageCharNames = await loadPageCharNames(page);
  const truth = await loadTruth(page);

  // The step selects with no ORDER BY, so rows came back in insertion
  // order, which is legacy_id order (mapBubbleRows numbers them b01, b02...).
  const bubbles = must(
    await supabase
      .from("bubbles")
      .select(
        "id, legacy_id, sort_order, box_2d, ocr_text, speaker, emotion, type",
      )
      .eq("book_id", BOOK)
      .eq("issue_id", ISSUE)
      .eq("page_number", page)
      .order("legacy_id"),
    "smoke bubbles read",
  );
  console.log(
    `page ${page}: ${bubbles.length} bubbles, characters from faces: ${pageCharNames.join(", ") || "(none)"}`,
  );

  const uniqueSpeakers: string[] = [];
  for (const b of bubbles) {
    if (limit !== undefined && rows.length >= limit) break pageLoop;
    const box = b.box_2d as Box | null;
    const ocrText = b.ocr_text?.trim() ?? "";
    if (!box?.width || !box.height || !ocrText) {
      console.log(`  skip ${b.legacy_id}: no box or no text`);
      continue;
    }

    const allCharacters = [...pageCharNames, ...uniqueSpeakers].filter(
      (name, i, arr) => arr.indexOf(name) === i,
    );
    const prompt = buildContextPrompt(ocrText, box, allCharacters, bookContext);
    const key = textKey(ocrText);
    const row: Row = {
      page,
      sortOrder: b.sort_order,
      bubbleId: b.id,
      text: ocrText,
      truth: truth.find((t) => t.key === key)?.triple ?? null,
      geminiHigh: { speaker: b.speaker, emotion: b.emotion, type: b.type },
      bench: null,
      parsed: false,
      rawReply: null,
      latencyMs: null,
      usage: null,
    };

    console.log(
      `  ${b.legacy_id}: ${ocrText.slice(0, 60).replace(/\s+/g, " ")}`,
    );
    const callsBefore = calls;
    const result = await callModel(imageUrl, prompt);
    if (result.kind === "stop") {
      stopReason = result.detail;
      console.error(`  stopping: ${result.detail}`);
      // A bubble that reached OpenRouter stays in the results as an error.
      if (calls > callsBefore) {
        row.rawReply = `error: ${result.detail}`;
        rows.push(row);
      }
      break pageLoop;
    }
    if (result.kind === "error") {
      row.rawReply = `error: ${result.detail}`;
      console.warn(`  error: ${result.detail}`);
    } else {
      const responseText =
        result.body.choices?.[0]?.message?.content?.trim() ?? "";
      row.rawReply = responseText;
      row.latencyMs = result.latencyMs;
      row.usage = result.body.usage ?? null;
      // Same parse as the step: scratchpad, greedy {...} match, JSON.parse.
      const scratchpad = /<scratchpad>([\s\S]*?)<\/scratchpad>/.exec(
        responseText,
      );
      const aiReasoning = scratchpad?.[1]?.trim() ?? null;
      const jsonMatch = /\{[\s\S]*\}/.exec(responseText);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as ContextParsed;
          const update = buildContextUpdate(parsed, ocrText, aiReasoning);
          row.parsed = true;
          row.bench = {
            speaker: update.speaker ?? null,
            emotion: update.emotion ?? null,
            type: update.type ?? null,
            textWithCues: update.text_with_cues ?? null,
          };
          const speaker = update.speaker ?? null;
          if (speaker && !uniqueSpeakers.includes(speaker)) {
            uniqueSpeakers.push(speaker);
          }
        } catch (e) {
          console.warn(
            `  reply did not parse: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      console.log(
        `    → ${row.bench ? `${row.bench.speaker} / ${row.bench.emotion} / ${row.bench.type}` : "unparsed"} (${row.latencyMs} ms); truth ${row.truth?.speaker ?? "none"}; GEMINI_HIGH ${b.speaker}`,
      );
    }
    rows.push(row);

    const more = limit === undefined || rows.length < limit;
    if (more) await sleep(BETWEEN_CALLS_MS);
  }
}

writeOutputs(rows, stopReason);
