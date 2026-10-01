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
 * `--variant` picks the images: `page` (what the step sends today),
 * `panel-page` (the page, then the bubble's panel cropped from it) or `panel`
 * (the panel crop alone). Panels are the reviewed ones on the truth page.
 *
 * Read-only on Supabase (select and Storage download). The only network
 * call besides Supabase is OpenRouter, and only for model ids ending in
 * `:free` or listed in PAID_OK.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/bench-speaker-model.ts \
 *     [--model google/gemma-4-31b-it:free] [--variant page|panel-page|panel] \
 *     [--pages 1,2] [--limit n] [--max-calls 40] \
 *     [--out /tmp/comic-reader-briefs/bench-out]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
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
const VARIANTS = ["page", "panel-page", "panel"] as const;
type Variant = (typeof VARIANTS)[number];
const PANEL_PAGE_PREFACE =
  "Two images follow. Image 1 is the full comic page. Image 2 is the one panel that contains the speech bubble, cropped from that page. The bounding box below is in Image 1's pixels. Use Image 2 to trace the bubble's tail to the speaker, and Image 1 to see who else is on the page.";
const PANEL_PREFACE =
  "The image is one panel cropped from a comic page. The bounding box below is in this image's pixels.";
/**
 * Names that are one character, for the alias-aware count. Covers the two
 * smoke pages only (tmnt-mmpr-iii issue-1 pages 7 and 8); keys and values are
 * already in `plain` form.
 */
const SAME_CHARACTER: Record<string, string> = {
  trini: "yellowranger",
  kimberly: "pinkranger",
  tommy: "greenranger",
  jason: "redranger",
  billy: "blueranger",
  zack: "blackranger",
};

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
const variant = (opt("--variant") ?? "page") as Variant;
if (!VARIANTS.includes(variant)) {
  die(`--variant takes ${VARIANTS.join(", ")}, got "${variant}"`);
}

// Paid ids the owner has named a spend for (#321). Anything else must be free.
const PAID_OK = ["google/gemma-4-31b-it", "google/gemini-3.8-flash"];
if (!model.endsWith(":free") && !PAID_OK.includes(model)) {
  die(
    `refusing model "${model}": only ids ending in ":free" or listed in PAID_OK are allowed`,
  );
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
  variant: Variant;
  page: number;
  /** The reviewed panel's label (`p07-02`), or null when none was sent. */
  panel: string | null;
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
/** `plain`, then SAME_CHARACTER folds a name onto its ranger color. */
const aliased = (s: string | null | undefined) => {
  const p = plain(s);
  return SAME_CHARACTER[p] ?? p;
};

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
      .select("ocr_text, text_with_cues, speaker, emotion, type, panel_id")
      .eq("book_id", TRUTH_BOOK)
      .eq("issue_id", TRUTH_ISSUE)
      .eq("page_number", TRUTH_PAGE[page]!)
      .or("ignored.is.null,ignored.eq.false"),
    "truth bubbles read",
  );
  return (rows ?? []).map((r) => ({
    key: textKey(r.ocr_text ?? r.text_with_cues),
    panelId: r.panel_id,
    triple: { speaker: r.speaker, emotion: r.emotion, type: r.type },
  }));
}

type Panel = { id: string; label: string; rect: Box };

/** Reviewed panels of the truth page, as pixel rects clamped to the image. */
async function loadPanels(
  page: number,
  imgW: number,
  imgH: number,
): Promise<Panel[]> {
  const rows = must(
    await supabase
      .from("panels")
      .select("id, panel_id, bounding_box")
      .eq("book_id", TRUTH_BOOK)
      .eq("issue_id", TRUTH_ISSUE)
      .eq("page_number", TRUTH_PAGE[page]!),
    "truth panels read",
  );
  const clamp = (n: number, lo: number, hi: number) =>
    Math.min(Math.max(n, lo), hi);
  return (rows ?? []).flatMap((p) => {
    const bb = p.bounding_box as {
      x: number;
      y: number;
      w: number;
      h: number;
    } | null;
    if (!bb) return [];
    const x = clamp(Math.round(bb.x * imgW), 0, imgW - 1);
    const y = clamp(Math.round(bb.y * imgH), 0, imgH - 1);
    const width = clamp(Math.round(bb.w * imgW), 1, imgW - x);
    const height = clamp(Math.round(bb.h * imgH), 1, imgH - y);
    return [{ id: p.id, label: p.panel_id, rect: { x, y, width, height } }];
  });
}

/** Area of `a` and `b` in common, in pixels. */
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** The bubble box in the crop's pixels, clamped to the crop. */
function boxInCrop(box: Box, crop: Box): Box {
  const cx = (n: number) => Math.min(Math.max(n - crop.x, 0), crop.width);
  const cy = (n: number) => Math.min(Math.max(n - crop.y, 0), crop.height);
  const x = cx(box.x);
  const y = cy(box.y);
  return {
    x,
    y,
    width: cx(box.x + box.width) - x,
    height: cy(box.y + box.height) - y,
  };
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

async function postOnce(imageUrls: string[], prompt: string) {
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
        // Asks OpenRouter to return the billed cost in `usage`.
        usage: { include: true },
        messages: [
          {
            role: "user",
            content: [
              ...imageUrls.map((url) => ({
                type: "image_url",
                image_url: { url },
              })),
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
async function callModel(imageUrls: string[], prompt: string) {
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
    const r = await postOnce(imageUrls, prompt);
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

function speakerVerdict(
  row: Row,
  t: Triple | null,
  norm: (s: string | null | undefined) => string = plain,
): string {
  if (!row.truth) return "no truth";
  if (!t) return "no answer";
  return norm(t.speaker) === norm(row.truth.speaker) ? "match" : "differs";
}

function writeOutputs(rows: Row[], stopReason: string | null) {
  mkdirSync(outDir, { recursive: true });
  const slug = model.replace(/[^a-zA-Z0-9]+/g, "-");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(outDir, `${slug}-${variant}-${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify(rows, null, 2));

  const withTruth = rows.filter((r) => r.truth);
  const count = (pick: (r: Row) => Triple | null, norm = plain) =>
    withTruth.filter((r) => speakerVerdict(r, pick(r), norm) === "match")
      .length;
  const gemMatches = count((r) => r.geminiHigh);
  const gemAliased = count((r) => r.geminiHigh, aliased);
  const benchMatches = count((r) => r.bench);
  const benchAliased = count((r) => r.bench, aliased);
  const costUsd = rows.reduce((sum, r) => {
    const c = (r.usage as { cost?: unknown } | null)?.cost;
    return typeof c === "number" ? sum + c : sum;
  }, 0);
  const latencies = rows
    .map((r) => r.latencyMs)
    .filter((ms): ms is number => ms != null)
    .sort((a, b) => a - b);
  const mid = Math.floor(latencies.length / 2);
  const medianMs =
    latencies.length === 0
      ? null
      : latencies.length % 2
        ? latencies[mid]!
        : Math.round((latencies[mid - 1]! + latencies[mid]!) / 2);
  const tokens = (u: unknown) => {
    const x = u as {
      prompt_tokens?: number;
      completion_tokens?: number;
    } | null;
    return x ? `${x.prompt_tokens ?? "?"}/${x.completion_tokens ?? "?"}` : "";
  };

  const header = [
    "page",
    "panel",
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
    "GEMINI_HIGH vs truth (aliases)",
    "bench vs truth (aliases)",
  ];
  const n = withTruth.length;
  const lines = [
    `# Speaker bench: ${model}, variant ${variant}`,
    "",
    `Smoke pages ${pages.join(", ")} (\`${BOOK}\` / \`${ISSUE}\`), truth from \`${TRUTH_BOOK}\` / \`${TRUTH_ISSUE}\`.`,
    "",
    `Totals: ${rows.length} bubbles sent, ${rows.filter((r) => r.parsed).length} replies parsed, ` +
      `speaker matches against truth (plain / with aliases): GEMINI_HIGH ${gemMatches}/${n} / ${gemAliased}/${n}, ` +
      `${model} ${benchMatches}/${n} / ${benchAliased}/${n}. ` +
      `Cost $${costUsd.toFixed(6)}, median latency ${medianMs ?? "n/a"} ms. OpenRouter requests: ${calls}.`,
    ...(stopReason ? ["", `Stopped early: ${stopReason}`] : []),
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (r) =>
        `| ${[
          r.page,
          r.panel,
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
          speakerVerdict(r, r.geminiHigh, aliased),
          speakerVerdict(r, r.bench, aliased),
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
  const pageBuf = Buffer.from(await blob.arrayBuffer());
  const imageUrl = `data:image/webp;base64,${pageBuf.toString("base64")}`;
  const pageCharNames = await loadPageCharNames(page);
  const truth = await loadTruth(page);
  let panels: Panel[] = [];
  const cropUrls = new Map<string, string>();
  if (variant !== "page") {
    const meta = await sharp(pageBuf).metadata();
    if (!meta.width || !meta.height) die(`page ${page}: no image size`);
    panels = await loadPanels(page, meta.width!, meta.height!);
  }
  /** The panel crop as a webp data URL, cut once per panel. */
  const cropUrl = async (p: Panel) => {
    let url = cropUrls.get(p.id);
    if (!url) {
      const buf = await sharp(pageBuf)
        .extract({
          left: p.rect.x,
          top: p.rect.y,
          width: p.rect.width,
          height: p.rect.height,
        })
        .webp()
        .toBuffer();
      url = `data:image/webp;base64,${buf.toString("base64")}`;
      cropUrls.set(p.id, url);
    }
    return url;
  };

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
    const key = textKey(ocrText);
    const truthRow = truth.find((t) => t.key === key);

    // The bubble's panel: the matched truth bubble's, else the reviewed
    // panel covering the largest share of the box, else none.
    let panel: Panel | null = null;
    if (variant !== "page") {
      panel = panels.find((p) => p.id === truthRow?.panelId) ?? null;
      if (!panel) {
        let best = 0;
        for (const p of panels) {
          const area = overlap(box, p.rect);
          if (area > best) [best, panel] = [area, p];
        }
      }
    }

    let images = [imageUrl];
    let prompt = buildContextPrompt(ocrText, box, allCharacters, bookContext);
    if (panel && variant === "panel-page") {
      images = [imageUrl, await cropUrl(panel)];
      prompt = `${PANEL_PAGE_PREFACE}\n\n${prompt}`;
    } else if (panel && variant === "panel") {
      images = [await cropUrl(panel)];
      const cropBox = boxInCrop(box, panel.rect);
      prompt = `${PANEL_PREFACE}\n\n${buildContextPrompt(ocrText, cropBox, allCharacters, bookContext)}`;
    }

    const row: Row = {
      variant,
      page,
      panel: panel?.label ?? null,
      sortOrder: b.sort_order,
      bubbleId: b.id,
      text: ocrText,
      truth: truthRow?.triple ?? null,
      geminiHigh: { speaker: b.speaker, emotion: b.emotion, type: b.type },
      bench: null,
      parsed: false,
      rawReply: null,
      latencyMs: null,
      usage: null,
    };

    console.log(
      `  ${b.legacy_id}${panel ? ` (${panel.label})` : ""}: ${ocrText.slice(0, 60).replace(/\s+/g, " ")}`,
    );
    const callsBefore = calls;
    const result = await callModel(images, prompt);
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
