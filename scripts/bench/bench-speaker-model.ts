/**
 * Bench get-context's speaker call on another model (#321).
 *
 * Replays the speaker prompt from getContextPage (src/workflows/steps/vision.ts):
 * the page image, `buildContextPrompt` with the same book context and
 * character list the step builds, and each bubble's stored `ocr_text` in place
 * of a fresh OCR call.
 *
 * `--source smoke` (default) walks the smoke pages (`smoke-test` /
 * `issue-smoke`, pages 1 and 2). Each answer is set against the reviewed
 * bubble on `tmnt-mmpr-iii` / `issue-1` page 7 or 8 (matched by text) and
 * against what GEMINI_HIGH wrote on the smoke row. `--source reviewed` walks
 * reviewed pages of `--book` / `--issue`, and the row itself is the truth.
 *
 * `--variant` picks the images: `page` (what the step sends today),
 * `panel-page` (the page, then the bubble's panel cropped from it) or `panel`
 * (the panel crop alone). Panels are the reviewed ones. #431 adds four
 * that keep today's whole page and change one thing: `no-cues` (the prompt
 * without the CUE_RULES block), `box-norm` (the Location line as
 * [ymin, xmin, ymax, xmax] scaled 0-1000 to the page), `box-drawn` (a magenta
 * outline drawn round the bubble's box on the page, and one sentence saying
 * so). `--dry-run` with `box-drawn` writes the first drawn page to `--out`.
 * Two more: `no-cues-panel-page` (the no-cues prompt with panel-page's two
 * images) and `two-call` (call 1 is the no-cues prompt with step 3 and the
 * `textWithCues` reply field taken out, scored as usual; call 2 is
 * `buildCuePrompt` on call 1's speaker and emotion, text only, at
 * `thinkingLevel: LOW` as the editor's Regenerate cues action sends it, and
 * its trimmed reply is the cue line). `--dry-run` with `two-call` prints one
 * call 2 prompt too.
 *
 * `--cast` picks the prompt. `closed` (the default for `--source reviewed`)
 * is #354's: the speaker must come from the issue's cast, here `proposeCast`
 * held in memory with each member's aliases from its `characters` row, listed
 * by `closedCastLines` with that page's face detections marked, and the book
 * context the step sends (name, franchises, synopsis). Scoring maps the
 * reviewed speaker and the reply to a cast id with `matchCastSpeaker`; a
 * reviewed speaker outside the cast is counted apart and left out. The old
 * GEMINI_HIGH run (`--baseline`, row 232) is scored on the same subset.
 * `open` (the default for `--source smoke`) is the pre-#354 prompt.
 *
 * `--dry-run` does every read and builds every prompt and truth id, prints the
 * cast, the counts and one full prompt, and exits before any model call.
 *
 * `--model` takes an id or a tier name (`GEMINI_HIGH`, `GEMINI_MEDIUM`,
 * `GEMINI_FAST`) from `src/lib/models.ts`; a tier is priced from
 * `GEMINI_USD_PER_1M_TOKENS` unless `--price-in` / `--price-out` are given.
 *
 * `--provider openrouter` (default) refuses ids that do not end in `:free`
 * and are not in PAID_OK. `--provider gemini` runs `gemma-` ids freely and
 * any other id only under LIVE_API_OK=1 (a spend the owner named). It writes
 * no `llm_calls` row. Read-only on Supabase (select and Storage download).
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/bench/bench-speaker-model.ts \
 *     [--provider openrouter|gemini] [--model <id>|GEMINI_HIGH] \
 *     [--source smoke|reviewed] [--book <id> --issue <id>] [--pages 1,2|3-13] \
 *     [--variant page|panel-page|panel|no-cues|box-norm|box-drawn|
 *       no-cues-panel-page|two-call] \
 *     [--cast closed|open] [--dry-run] \
 *     [--baseline <old run .json>] [--limit n] [--max-calls 40] \
 *     [--page-concurrency 1] [--price-in <usd/1M> --price-out <usd/1M>] \
 *     [--out <dir>, default ~/comic-reader-bench]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ApiError,
  GoogleGenAI,
  ThinkingLevel,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";
import sharp from "sharp";
import { loadBookCast, proposeCast } from "~/lib/cast";
import { CUE_RULES, buildCuePrompt } from "~/lib/cue-rules";
import { buildContextPrompt } from "~/lib/gemini-prompts";
import { selectIssue } from "~/lib/issue-queries";
import {
  GEMINI_FAST,
  GEMINI_HIGH,
  GEMINI_MEDIUM,
  GEMINI_USD_PER_1M_TOKENS,
} from "~/lib/models";
import { pageStoragePath } from "~/lib/storage";
import { createTypedStepClient } from "~/workflows/step-utils";
import {
  CLOSED_CAST_NOTES,
  buildContextUpdate,
  closedCastLines,
  contextSpeakerReply,
  matchCastSpeaker,
  type ClosedCastMember,
  type ContextParsed,
} from "~/workflows/steps/vision-rows";

const SMOKE_BOOK = "smoke-test";
const SMOKE_ISSUE = "issue-smoke";
const TRUTH_BOOK = "tmnt-mmpr-iii";
const TRUTH_ISSUE = "issue-1";
/** Smoke page → the source page smoke-ingest copied it from. */
const TRUTH_PAGE: Record<number, number> = { 1: 7, 2: 8 };
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const BETWEEN_CALLS_MS = 4_000;
const RETRY_WAIT_MS = 20_000;
const MATCH_CHARS = 40;
const VARIANTS = [
  "page",
  "panel-page",
  "panel",
  "no-cues",
  "box-norm",
  "box-drawn",
  "no-cues-panel-page",
  "two-call",
] as const;
type Variant = (typeof VARIANTS)[number];
const PROVIDERS = ["openrouter", "gemini"] as const;
type Provider = (typeof PROVIDERS)[number];
const SOURCES = ["smoke", "reviewed"] as const;
type Source = (typeof SOURCES)[number];
const CAST_MODES = ["closed", "open"] as const;
type CastMode = (typeof CAST_MODES)[number];
/** Where run files go without `--out`: outside /tmp, which lost bench files once (#431). */
const DEFAULT_OUT = join(homedir(), "comic-reader-bench");
/** `--model` may name a tier; the id comes from `src/lib/models.ts`. */
const TIERS: Record<string, string> = {
  GEMINI_HIGH,
  GEMINI_MEDIUM,
  GEMINI_FAST,
};
const PANEL_PAGE_PREFACE =
  "Two images follow. Image 1 is the full comic page. Image 2 is the one panel that contains the speech bubble, cropped from that page. The bounding box below is in Image 1's pixels. Use Image 2 to trace the bubble's tail to the speaker, and Image 1 to see who else is on the page.";
/** `box-drawn`: the outline drawn on the page, and the sentence that says so. */
const OUTLINE_PX = 6;
const OUTLINE_SENTENCE =
  "* **Outline:** The target text is outlined with a magenta rectangle on the page.";
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
const priceOpt = (name: string) => {
  const raw = opt(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) die(`${name} wants a price in USD per 1M`);
  return n;
};
function oneOf<T extends string>(name: string, all: readonly T[], def: T): T {
  const v = (opt(name) ?? def) as T;
  if (!all.includes(v)) die(`${name} takes ${all.join(", ")}, got "${v}"`);
  return v;
}
/** "1,2", "3-13" or a mix, sorted and deduplicated. */
function parsePages(raw: string): number[] {
  const out = raw.split(",").flatMap((part) => {
    const range = /^(\d+)-(\d+)$/.exec(part.trim());
    if (range) {
      const [lo, hi] = [Number(range[1]), Number(range[2])];
      if (lo < 1 || hi < lo) die(`--pages: bad range "${part}"`);
      return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1) die(`--pages: bad page "${part}"`);
    return [n];
  });
  return [...new Set(out)].sort((a, b) => a - b);
}

const provider = oneOf("--provider", PROVIDERS, "openrouter");
const source = oneOf("--source", SOURCES, "smoke");
const variant = oneOf("--variant", VARIANTS, "page");
const usesPanel =
  variant === "panel-page" ||
  variant === "panel" ||
  variant === "no-cues-panel-page";
/** Variants that send the prompt without the CUE_RULES block. */
const cutsCues =
  variant === "no-cues" ||
  variant === "no-cues-panel-page" ||
  variant === "two-call";
const twoCall = variant === "two-call";
/**
 * `--speaker-thinking low|medium` (two-call only): call 1's thinkingLevel.
 * Unset sends no thinkingConfig, as the step does. SDK 1.30's enum has no
 * MEDIUM, so its wire value goes as the string.
 */
const speakerThinkingArg = opt("--speaker-thinking");
if (speakerThinkingArg && !["low", "medium"].includes(speakerThinkingArg)) {
  die(`--speaker-thinking takes low or medium, got "${speakerThinkingArg}"`);
}
if (speakerThinkingArg && !twoCall)
  die("--speaker-thinking needs --variant two-call");
const speakerThinking: ThinkingLevel | undefined =
  speakerThinkingArg === "low"
    ? ThinkingLevel.LOW
    : speakerThinkingArg === "medium"
      ? ("MEDIUM" as ThinkingLevel)
      : undefined;
const castMode = oneOf(
  "--cast",
  CAST_MODES,
  source === "reviewed" ? "closed" : "open",
);
if (castMode === "closed" && source !== "reviewed") {
  die("--cast closed needs --source reviewed (each row is its own truth)");
}
const closed = castMode === "closed";
const dryRun = argv.includes("--dry-run");
const baselinePath = opt("--baseline");
const modelArg =
  opt("--model") ??
  (provider === "openrouter"
    ? "google/gemma-4-31b-it:free"
    : die("--provider gemini needs --model"));
const model = TIERS[modelArg] ?? modelArg;
const pages = parsePages(opt("--pages") ?? "1,2");
const limit = intOpt("--limit", undefined);
const maxCalls = intOpt("--max-calls", 40)!;
const concurrency = intOpt("--page-concurrency", 1)!;
const outDir = opt("--out") ?? DEFAULT_OUT;
if (twoCall && provider !== "gemini")
  die("--variant two-call needs --provider gemini");
const tierRate =
  provider === "gemini" ? GEMINI_USD_PER_1M_TOKENS[model] : undefined;
const priceIn = priceOpt("--price-in") ?? tierRate?.input;
const priceOut = priceOpt("--price-out") ?? tierRate?.output;
const priced = priceIn !== undefined && priceOut !== undefined;

// Paid ids the owner has named a spend for (#321). Anything else must be free.
const PAID_OK = ["google/gemma-4-31b-it", "google/gemini-3.8-flash"];
let openRouterKey: string | undefined;
let gemini: GoogleGenAI | null = null;
if (dryRun) {
  // No model call: no key, no client, no spend gate.
} else if (provider === "openrouter") {
  if (!model.endsWith(":free") && !PAID_OK.includes(model)) {
    die(
      `refusing model "${model}": only ids ending in ":free" or listed in PAID_OK are allowed`,
    );
  }
  openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) die("OPENROUTER_API_KEY is not set in .env");
} else {
  // Gemma on the Gemini API is free of charge; every other id is a spend.
  if (!model.startsWith("gemma-") && process.env.LIVE_API_OK !== "1") {
    die(
      `refusing model "${model}" on the Gemini API: only "gemma-" ids run without LIVE_API_OK=1 (a spend the owner named)`,
    );
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) die("GEMINI_API_KEY is not set in .env");
  gemini = new GoogleGenAI({ apiKey });
}

const book = source === "smoke" ? SMOKE_BOOK : opt("--book");
const issue = source === "smoke" ? SMOKE_ISSUE : opt("--issue");
if (!book || !issue) die("--source reviewed needs --book and --issue");
if (source === "smoke") {
  for (const p of pages) {
    if (!(p in TRUTH_PAGE)) die(`--source smoke takes pages 1 and/or 2`);
  }
}

// ── Types ───────────────────────────────────────────────────────────────
type Box = { x: number; y: number; width: number; height: number };
type Triple = {
  speaker: string | null;
  emotion: string | null;
  type: string | null;
};
type Row = {
  provider: Provider;
  source: Source;
  variant: Variant;
  cast: CastMode;
  page: number;
  /** The reviewed panel's label (`p07-02`), or null when none was sent. */
  panel: string | null;
  sortOrder: number | null;
  bubbleId: string;
  text: string;
  truth: Triple | null;
  /** What GEMINI_HIGH wrote on the smoke row; null for `--source reviewed`. */
  geminiHigh: Triple | null;
  bench: (Triple & { textWithCues: string | null }) | null;
  parsed: boolean;
  rawReply: string | null;
  /**
   * `--cast closed`: the reviewed speaker's cast id, by `matchCastSpeaker`,
   * else by identity (`truthIdOf`); null when outside the cast.
   */
  truthId: string | null;
  /** `--cast closed`: the reviewed speaker's cast id by `matchCastSpeaker` alone. */
  truthIdStrict: string | null;
  /** `--cast closed`: the name the reply gives (`contextSpeakerReply`), before matching. */
  replySpeaker: string | null;
  /** `--cast closed`: the cast id the reply maps to; null when none. */
  replyId: string | null;
  latencyMs: number | null;
  usage: unknown;
  costUsd: number | null;
  /** `two-call`: call 2 (the cue call); all null on other variants. */
  cue?: {
    speakerSent: string | null;
    emotionSent: string | null;
    reply: string | null;
    latencyMs: number | null;
    usage: unknown;
    costUsd: number | null;
  } | null;
};
/** One bubble to send, whichever source it came from. */
type BenchBubble = {
  id: string;
  label: string | null;
  sortOrder: number | null;
  box: Box | null;
  text: string;
  /** The panel to crop when the variant wants one (a `panels.id`). */
  panelId: string | null;
  truth: Triple | null;
  geminiHigh: Triple | null;
};
type Panel = { id: string; label: string; rect: Box };

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

// ── Reads, as getContextPage does them ──────────────────────────────────
/**
 * `--cast closed` sends what the #354 step sends: book name, franchises and
 * synopsis, or nothing when all three are empty. `open` adds the wiki names
 * and the canonical-names line, as the step did before #354.
 */
async function loadBookContext(
  bookId: string,
  issueId: string,
): Promise<string | undefined> {
  const [bookRes, issueRes] = await Promise.all([
    supabase.from("books").select("name, franchises").eq("id", bookId).single(),
    selectIssue(
      supabase,
      bookId,
      issueId,
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
  if (closed) return parts.length > 0 ? parts.join("\n") : undefined;
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

/**
 * The issue's cast for `--cast closed`: `proposeCast` (read-only), each
 * member's aliases from its `characters` row. Held in memory, never written.
 */
async function loadClosedCast(bookId: string, issueId: string) {
  const [proposal, bookCast] = await Promise.all([
    proposeCast(supabase, bookId, issueId),
    loadBookCast(supabase, bookId),
  ]);
  const cast: ClosedCastMember[] = proposal.members.map((m) => ({
    id: m.id,
    name: m.name,
    aliases: bookCast.resolve(m.id)?.aliases ?? [],
  }));
  return { cast, suggestions: proposal.suggestions };
}

/**
 * The page's face detections as getContextPage reads them: the
 * `character_id`s (`--cast closed` marks those members seen) and, for
 * `--cast open`, the same ids as names.
 */
async function loadPageDetections(
  bookId: string,
  issueId: string,
  page: number,
): Promise<{ names: string[]; seenIds: Set<string> }> {
  const panels = must(
    await supabase
      .from("panels")
      .select("id, page_number")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", page),
    "panels read",
  );
  const names: string[] = [];
  const seenIds = new Set<string>();
  if (!panels || panels.length === 0) return { names, seenIds };
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
    seenIds.add(d.character_id);
    const name = d.character_id.replace(/-/g, " ");
    if (!names.includes(name)) names.push(name);
  }
  return { names, seenIds };
}

/** Reviewed panels of a page, as pixel rects clamped to the image. */
async function loadPanels(
  bookId: string,
  issueId: string,
  page: number,
  imgW: number,
  imgH: number,
): Promise<Panel[]> {
  const rows = must(
    await supabase
      .from("panels")
      .select("id, panel_id, bounding_box")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", page),
    "reviewed panels read",
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
    // Clamp both edges, so a box that starts off the page shrinks instead of
    // sliding onto the pixels beside it.
    const x = clamp(Math.round(bb.x * imgW), 0, imgW - 1);
    const y = clamp(Math.round(bb.y * imgH), 0, imgH - 1);
    const right = clamp(Math.round((bb.x + bb.w) * imgW), x + 1, imgW);
    const bottom = clamp(Math.round((bb.y + bb.h) * imgH), y + 1, imgH);
    const width = right - x;
    const height = bottom - y;
    return [{ id: p.id, label: p.panel_id, rect: { x, y, width, height } }];
  });
}

/** Smoke rows in the step's walk order, matched to the reviewed page. */
async function loadSmokeBubbles(page: number): Promise<BenchBubble[]> {
  const truth = must(
    await supabase
      .from("bubbles")
      .select("ocr_text, text_with_cues, speaker, emotion, type, panel_id")
      .eq("book_id", TRUTH_BOOK)
      .eq("issue_id", TRUTH_ISSUE)
      .eq("page_number", TRUTH_PAGE[page]!)
      .or("ignored.is.null,ignored.eq.false"),
    "truth bubbles read",
  ).map((r) => ({
    key: textKey(r.ocr_text ?? r.text_with_cues),
    panelId: r.panel_id,
    triple: { speaker: r.speaker, emotion: r.emotion, type: r.type },
  }));

  // The step selects with no ORDER BY, so rows came back in insertion
  // order, which is legacy_id order (mapBubbleRows numbers them b01, b02...).
  const rows = must(
    await supabase
      .from("bubbles")
      .select(
        "id, legacy_id, sort_order, box_2d, ocr_text, speaker, emotion, type",
      )
      .eq("book_id", SMOKE_BOOK)
      .eq("issue_id", SMOKE_ISSUE)
      .eq("page_number", page)
      .order("legacy_id"),
    "smoke bubbles read",
  );
  return rows.map((b) => {
    const text = b.ocr_text?.trim() ?? "";
    const match = truth.find((t) => t.key === textKey(text));
    return {
      id: b.id,
      label: b.legacy_id,
      sortOrder: b.sort_order,
      box: b.box_2d as Box | null,
      text,
      panelId: match?.panelId ?? null,
      truth: match?.triple ?? null,
      geminiHigh: { speaker: b.speaker, emotion: b.emotion, type: b.type },
    };
  });
}

/**
 * Reviewed rows: `box_2d` when it has `x` (rounded, as mapBubbleRows stores
 * it), else `style` percents times the page size.
 */
function reviewedBox(box2d: unknown, style: unknown, w: number, h: number) {
  const b = box2d as Partial<Box> | null;
  const s = style as Partial<Record<keyof Box | "left" | "top", string>>;
  const box =
    typeof b?.x === "number"
      ? { x: b.x, y: b.y ?? 0, width: b.width ?? 0, height: b.height ?? 0 }
      : {
          x: (Number.parseFloat(s?.left ?? "") / 100) * w,
          y: (Number.parseFloat(s?.top ?? "") / 100) * h,
          width: (Number.parseFloat(s?.width ?? "") / 100) * w,
          height: (Number.parseFloat(s?.height ?? "") / 100) * h,
        };
  const rounded = {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
  return Object.values(rounded).every(Number.isFinite) ? rounded : null;
}

async function loadReviewedBubbles(
  page: number,
  w: number,
  h: number,
): Promise<BenchBubble[]> {
  const rows = must(
    await supabase
      .from("bubbles")
      .select(
        "id, legacy_id, sort_order, box_2d, style, ocr_text, speaker, emotion, type, panel_id",
      )
      .eq("book_id", book!)
      .eq("issue_id", issue!)
      .eq("page_number", page)
      .or("ignored.is.null,ignored.eq.false")
      .order("sort_order"),
    "reviewed bubbles read",
  );
  return rows.map((b) => ({
    id: b.id,
    label: b.legacy_id,
    sortOrder: b.sort_order,
    box: reviewedBox(b.box_2d, b.style, w, h),
    text: b.ocr_text?.trim() ?? "",
    panelId: b.panel_id,
    truth: { speaker: b.speaker, emotion: b.emotion, type: b.type },
    geminiHigh: null,
  }));
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

// ── Providers ───────────────────────────────────────────────────────────
/** One HTTP request's outcome; `ok` is set when a reply came back. */
type Attempt = {
  status: number;
  detail: string;
  latencyMs: number;
  ok?: { reply: string; usage: unknown };
};

/** `images` are base64 webp, in the order they are sent. */
async function attemptOpenRouter(
  images: string[],
  prompt: string,
): Promise<Attempt> {
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
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
              ...images.map((b64) => ({
                type: "image_url",
                image_url: { url: `data:image/webp;base64,${b64}` },
              })),
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });
    const text = await res.text();
    const latencyMs = Date.now() - started;
    if (!res.ok) return { status: res.status, detail: text, latencyMs };
    try {
      const body = JSON.parse(text) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: unknown;
      };
      const reply = body.choices?.[0]?.message?.content?.trim() ?? "";
      return {
        status: res.status,
        detail: "",
        latencyMs,
        ok: { reply, usage: body.usage ?? null },
      };
    } catch {
      return {
        status: res.status,
        detail: `body is not JSON: ${text.slice(0, 500)}`,
        latencyMs,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 0, detail: `fetch failed: ${msg}`, latencyMs: 0 };
  }
}

/** The get-context call shape: image parts in order, then the text part. */
async function attemptGemini(
  images: string[],
  prompt: string,
  thinking?: ThinkingLevel,
): Promise<Attempt> {
  const started = Date.now();
  try {
    const res = await gemini!.models.generateContent({
      model,
      // Text only (call 2) goes as the plain string, as regenerateCues sends it.
      contents:
        images.length === 0
          ? prompt
          : [
              ...images.map((b64) => createPartFromBase64(b64, "image/webp")),
              createPartFromText(prompt),
            ],
      ...(thinking
        ? { config: { thinkingConfig: { thinkingLevel: thinking } } }
        : {}),
    });
    return {
      status: 200,
      detail: "",
      latencyMs: Date.now() - started,
      ok: { reply: res.text?.trim() ?? "", usage: res.usageMetadata ?? null },
    };
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 0;
    const msg = e instanceof Error ? e.message : String(e);
    return { status, detail: msg, latencyMs: 0 };
  }
}

let calls = 0;
/** Set when the whole run must end (call ceiling, a request the API refuses). */
let halted: string | null = null;
type CallResult =
  | { kind: "ok"; reply: string; usage: unknown; latencyMs: number }
  | { kind: "error"; detail: string }
  | { kind: "stop-page"; detail: string }
  | { kind: "stop-run"; detail: string };

const retryable = (status: number) =>
  status === 0 || status === 429 || status >= 500;

/** One request, one retry after 20 s on 429/5xx, never past --max-calls. */
async function callModel(
  images: string[],
  prompt: string,
  log: (s: string) => void,
  thinking?: ThinkingLevel,
): Promise<CallResult> {
  let first: Attempt | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1) {
      log(`  HTTP ${first!.status}, retrying in 20 s`);
      await sleep(RETRY_WAIT_MS);
    }
    // Check and count with no await between them: another page may have
    // sent during the retry wait, and the ceiling has to hold across pages.
    if (calls >= maxCalls) {
      return {
        kind: "stop-run",
        detail:
          `--max-calls ${maxCalls} reached` +
          (first ? ` after HTTP ${first.status}: ${first.detail}` : ""),
      };
    }
    calls++;
    const r =
      provider === "openrouter"
        ? await attemptOpenRouter(images, prompt)
        : await attemptGemini(images, prompt, thinking);
    if (r.ok) return { kind: "ok", ...r.ok, latencyMs: r.latencyMs };
    if (r.status >= 200 && r.status < 300) {
      return { kind: "error", detail: `HTTP ${r.status}, ${r.detail}` };
    }
    if (!retryable(r.status)) {
      // A 4xx other than 429 (an image the API rejects, a bad id): stop.
      return { kind: "stop-run", detail: `HTTP ${r.status}: ${r.detail}` };
    }
    if (first?.status === 429 && r.status === 429) {
      return {
        kind: "stop-page",
        detail: `second consecutive 429: ${r.detail}`,
      };
    }
    first = r;
  }
  return {
    kind: "error",
    detail: `HTTP ${first!.status} twice: ${first!.detail.slice(0, 500)}`,
  };
}

/** USD for one reply: OpenRouter's billed cost, or the Gemini token price. */
function rowCost(usage: unknown): number | null {
  if (provider === "openrouter") {
    const c = (usage as { cost?: unknown } | null)?.cost;
    return typeof c === "number" ? c : null;
  }
  if (!priced || !usage) return null;
  const u = usage as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  const out = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  return ((u.promptTokenCount ?? 0) * priceIn! + out * priceOut!) / 1e6;
}

/** "in/out" tokens, out counting thinking for Gemini. */
function tokenCell(usage: unknown): string {
  if (!usage) return "";
  if (provider === "openrouter") {
    const u = usage as { prompt_tokens?: number; completion_tokens?: number };
    return `${u.prompt_tokens ?? "?"}/${u.completion_tokens ?? "?"}`;
  }
  const u = usage as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  const out = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  return `${u.promptTokenCount ?? "?"}/${out}`;
}

// ── One page ────────────────────────────────────────────────────────────
let bubblesSent = 0;
const limitReached = () => limit !== undefined && bubblesSent >= limit;
/** `--cast closed`: the issue's cast, loaded once before any page. */
let cast: ClosedCastMember[] = [];
/** `--dry-run`: the first prompt built, printed in full. */
let samplePrompt: { label: string; images: number; prompt: string } | null =
  null;
/** `--dry-run` with `two-call`: one call 2 prompt, built from the truth row. */
let sampleCuePrompt: string | null = null;
/** `--dry-run` with `box-drawn`: where the first drawn page was written. */
let drawnSample: string | null = null;
/** `--dry-run`: each page's seen ids, for the printout. */
const seenByPage = new Map<number, string[]>();

/**
 * The cast id a reviewed row's speaker maps to. Strict: `matchCastSpeaker`,
 * as the step stores a reply. Folded: strict, else row 232's identity rule
 * (`aliased`, so "Trini" is the Yellow Ranger) against each member's id, name
 * and aliases. Truth side only; a reply is never folded.
 */
function truthIdOf(t: Triple | null): {
  strict: string | null;
  folded: string | null;
} {
  if (!t) return { strict: null, folded: null };
  const said = contextSpeakerReply({
    type: t.type ?? undefined,
    speaker: t.speaker,
  });
  const strict = matchCastSpeaker(said, cast)?.id ?? null;
  if (strict || !said) return { strict, folded: strict };
  const key = aliased(said);
  const member = key
    ? cast.find((m) =>
        [m.id, m.name, ...m.aliases].some((n) => aliased(n) === key),
      )
    : undefined;
  return { strict, folded: member?.id ?? null };
}

async function runPage(
  page: number,
  bookContext: string | undefined,
): Promise<{ rows: Row[]; stop: string | null }> {
  const log = (s: string) => console.log(`[p${page}] ${s}`);
  const blob = must(
    await supabase.storage
      .from("comic-pages")
      .download(pageStoragePath(book!, issue!, page)),
    `comic-pages download for page ${page}`,
  );
  const pageBuf = Buffer.from(await blob.arrayBuffer());
  const pageB64 = pageBuf.toString("base64");
  const meta = await sharp(pageBuf).metadata();
  if (!meta.width || !meta.height) die(`page ${page}: no image size`);
  const [w, h] = [meta.width!, meta.height!];
  const { names: pageCharNames, seenIds } = await loadPageDetections(
    book!,
    issue!,
    page,
  );
  seenByPage.set(
    page,
    [...seenIds].filter((id) => cast.some((m) => m.id === id)),
  );
  const castLines = closed ? closedCastLines(cast, seenIds) : [];
  const promptOpts = closed
    ? { closedList: true, castNotes: CLOSED_CAST_NOTES }
    : undefined;
  // Panels come from the reviewed issue: the source page for smoke.
  const panels = !usesPanel
    ? []
    : source === "smoke"
      ? await loadPanels(TRUTH_BOOK, TRUTH_ISSUE, TRUTH_PAGE[page]!, w, h)
      : await loadPanels(book!, issue!, page, w, h);
  const bubbles =
    source === "smoke"
      ? await loadSmokeBubbles(page)
      : await loadReviewedBubbles(page, w, h);
  log(
    `${bubbles.length} bubbles, characters from faces: ${pageCharNames.join(", ") || "(none)"}`,
  );

  const crops = new Map<string, string>();
  /** The panel crop as base64 webp, cut once per panel. */
  const crop = async (p: Panel) => {
    let b64 = crops.get(p.id);
    if (!b64) {
      const buf = await sharp(pageBuf)
        .extract({
          left: p.rect.x,
          top: p.rect.y,
          width: p.rect.width,
          height: p.rect.height,
        })
        .webp()
        .toBuffer();
      b64 = buf.toString("base64");
      crops.set(p.id, b64);
    }
    return b64;
  };

  /** `box-drawn`: the page with a magenta outline round `box`, base64 webp. */
  const drawBox = async (box: Box) => {
    // The stroke sits just outside the box, so it never covers the letters.
    const pad = OUTLINE_PX / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="${box.x - pad}" y="${box.y - pad}" width="${box.width + OUTLINE_PX}" height="${box.height + OUTLINE_PX}" fill="none" stroke="#ff00ff" stroke-width="${OUTLINE_PX}"/></svg>`;
    const buf = await sharp(pageBuf)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .webp()
      .toBuffer();
    return buf.toString("base64");
  };

  const rows: Row[] = [];
  const uniqueSpeakers: string[] = [];
  for (const b of bubbles) {
    if (halted || limitReached()) break;
    const box = b.box;
    if (!box?.width || !box.height || !b.text) {
      log(`skip ${b.label}: no box or no text`);
      continue;
    }

    // Closed: the cast lines the step sends. Open: the pre-#354 list, face
    // names plus the speakers this page's replies have named so far.
    const allCharacters = closed
      ? castLines
      : [...pageCharNames, ...uniqueSpeakers].filter(
          (name, i, arr) => arr.indexOf(name) === i,
        );

    // The bubble's panel: its known panel, else the reviewed panel covering
    // the largest share of the box, else none.
    let panel: Panel | null = null;
    if (usesPanel) {
      panel = panels.find((p) => p.id === b.panelId) ?? null;
      if (!panel) {
        let best = 0;
        for (const p of panels) {
          const area = overlap(box, p.rect);
          if (area > best) [best, panel] = [area, p];
        }
      }
    }

    let images = [pageB64];
    let prompt = buildContextPrompt(
      b.text,
      box,
      allCharacters,
      bookContext,
      promptOpts,
    );
    if (cutsCues) {
      // The block as buildContextPrompt places it; for the no-cues variants
      // step 3's sentence that asks for textWithCues stays, so the reply
      // keeps the same JSON.
      const cut = prompt.replace(`\n\n${CUE_RULES}\n`, "\n");
      if (cut === prompt) die(`${variant}: CUE_RULES not found in the prompt`);
      prompt = cut;
    }
    if (twoCall) {
      // Call 1 drops step 3 and the textWithCues field of the example reply.
      const step3 = /\n3\.  \*\*Performance Cues \(CRITICAL\):\*\*\n[^\n]*\n/;
      if (!step3.test(prompt)) die("two-call: step 3 not found in the prompt");
      prompt = prompt.replace(step3, "");
      const field =
        ',\n  "textWithCues": "[shouting, aggressive] You will never defeat us, turtles!"\n}';
      if (!prompt.includes(field))
        die("two-call: textWithCues field not found");
      prompt = prompt.replace(field, "\n}");
      if (/textWithCues|cue rules|Cue rules/.test(prompt)) {
        die("two-call: the prompt still mentions cues");
      }
    }
    if (variant === "no-cues-panel-page" && panel) {
      images = [pageB64, await crop(panel)];
      prompt = `${PANEL_PAGE_PREFACE}\n\n${prompt}`;
    } else if (variant === "box-norm") {
      const at = (n: number, size: number) => Math.round((n / size) * 1000);
      const norm = [
        at(box.y, h),
        at(box.x, w),
        at(box.y + box.height, h),
        at(box.x + box.width, w),
      ];
      const line = `* **Location:** x:${box.x}, y:${box.y} (width:${box.width}, height:${box.height})`;
      if (!prompt.includes(line)) die("box-norm: Location line not found");
      prompt = prompt.replace(
        line,
        `* **Location (box as [ymin, xmin, ymax, xmax], scaled 0-1000 to the page):** [${norm.join(", ")}]`,
      );
    } else if (variant === "box-drawn") {
      images = [await drawBox(box)];
      const line = `* **Location:** x:${box.x}, y:${box.y} (width:${box.width}, height:${box.height})`;
      if (!prompt.includes(line)) die("box-drawn: Location line not found");
      prompt = prompt.replace(line, `${line}\n${OUTLINE_SENTENCE}`);
      if (dryRun && !drawnSample) {
        drawnSample = join(
          outDir,
          `box-drawn-sample-p${page}-${b.label ?? b.id}.png`,
        );
        mkdirSync(outDir, { recursive: true });
        await sharp(Buffer.from(images[0]!, "base64"))
          .png()
          .toFile(drawnSample);
        log(`wrote ${drawnSample}`);
      }
    } else if (panel && variant === "panel-page") {
      images = [pageB64, await crop(panel)];
      prompt = `${PANEL_PAGE_PREFACE}\n\n${prompt}`;
    } else if (panel && variant === "panel") {
      images = [await crop(panel)];
      const cropBox = boxInCrop(box, panel.rect);
      prompt = `${PANEL_PREFACE}\n\n${buildContextPrompt(b.text, cropBox, allCharacters, bookContext, promptOpts)}`;
    }

    const row: Row = {
      provider,
      source,
      variant,
      cast: castMode,
      page,
      panel: panel?.label ?? null,
      sortOrder: b.sortOrder,
      bubbleId: b.id,
      text: b.text,
      truth: b.truth,
      geminiHigh: b.geminiHigh,
      bench: null,
      parsed: false,
      rawReply: null,
      truthId: closed ? truthIdOf(b.truth).folded : null,
      truthIdStrict: closed ? truthIdOf(b.truth).strict : null,
      replySpeaker: null,
      replyId: null,
      latencyMs: null,
      usage: null,
      costUsd: null,
    };

    log(
      `${b.label}${panel ? ` (${panel.label})` : ""}: ${b.text.slice(0, 60).replace(/\s+/g, " ")}`,
    );
    bubblesSent++;
    if (dryRun) {
      samplePrompt ??= {
        label: `page ${page} ${b.label ?? b.id}`,
        images: images.length,
        prompt,
      };
      if (twoCall) {
        sampleCuePrompt ??= buildCuePrompt({
          text: b.text,
          emotion: b.truth?.emotion ?? null,
          speaker: row.truthId,
        });
      }
      rows.push(row);
      continue;
    }
    const callsBefore = calls;
    const result = await callModel(images, prompt, log, speakerThinking);
    if (result.kind === "stop-page" || result.kind === "stop-run") {
      log(
        `stopping ${result.kind === "stop-run" ? "the run" : "this page"}: ${result.detail}`,
      );
      if (result.kind === "stop-run") halted ??= result.detail;
      // A bubble that reached the API stays in the results as an error.
      if (calls > callsBefore) {
        row.rawReply = `error: ${result.detail}`;
        rows.push(row);
      }
      return { rows, stop: `page ${page}: ${result.detail}` };
    }
    if (result.kind === "error") {
      row.rawReply = `error: ${result.detail}`;
      log(`error: ${result.detail}`);
    } else {
      const responseText = result.reply;
      row.rawReply = responseText;
      row.latencyMs = result.latencyMs;
      row.usage = result.usage;
      row.costUsd = rowCost(result.usage);
      // Same parse as the step: scratchpad, greedy {...} match, JSON.parse.
      const scratchpad = /<scratchpad>([\s\S]*?)<\/scratchpad>/.exec(
        responseText,
      );
      const aiReasoning = scratchpad?.[1]?.trim() ?? null;
      const jsonMatch = /\{[\s\S]*\}/.exec(responseText);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as ContextParsed;
          // Closed: the step's own update, speaker matched to the cast.
          // Open: the reply's name as given (the cast is empty).
          const update = buildContextUpdate(parsed, b.text, aiReasoning, cast);
          const replySpeaker = contextSpeakerReply(parsed);
          row.parsed = true;
          row.replySpeaker = replySpeaker;
          row.replyId = closed ? (update.character_id ?? null) : null;
          row.bench = {
            speaker: closed ? (update.speaker ?? null) : replySpeaker,
            emotion: update.emotion ?? null,
            type: update.type ?? null,
            textWithCues: update.text_with_cues ?? null,
          };
          if (twoCall) row.bench.textWithCues = null;
          const speaker = row.bench.speaker;
          if (!closed && speaker && !uniqueSpeakers.includes(speaker)) {
            uniqueSpeakers.push(speaker);
          }
        } catch (e) {
          log(
            `reply did not parse: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (twoCall && row.parsed && row.bench) {
        // Call 2: the emotion as the step stores it, the speaker as call 1's
        // cast id, else the name it gave.
        const speakerSent = row.replyId ?? row.replySpeaker ?? null;
        const emotionSent = row.bench.emotion;
        const cue: NonNullable<Row["cue"]> = {
          speakerSent,
          emotionSent,
          reply: null,
          latencyMs: null,
          usage: null,
          costUsd: null,
        };
        row.cue = cue;
        const r2 = await callModel(
          [],
          buildCuePrompt({
            text: b.text,
            emotion: emotionSent,
            speaker: speakerSent,
          }),
          log,
          ThinkingLevel.LOW,
        );
        if (r2.kind === "ok") {
          // Parsed as regenerateCues does: the trimmed text, empty is a failure.
          cue.reply = r2.reply.trim() || null;
          cue.latencyMs = r2.latencyMs;
          cue.usage = r2.usage;
          cue.costUsd = rowCost(r2.usage);
          row.bench.textWithCues = cue.reply;
          log(`  cue: ${cue.reply ?? "(empty reply)"} (${r2.latencyMs} ms)`);
        } else {
          log(`  cue call failed: ${r2.detail}`);
          if (r2.kind === "stop-run") halted ??= r2.detail;
        }
      }
      log(
        `  → ${row.bench ? `${row.bench.speaker} / ${row.bench.emotion} / ${row.bench.type}` : "unparsed"}${closed && row.parsed ? ` (reply ${JSON.stringify(row.replySpeaker)} → ${row.replyId ?? "no cast member"})` : ""} (${row.latencyMs} ms); truth ${row.truth?.speaker ?? "none"}${closed ? ` → ${row.truthId ?? "outside the cast"}` : ""}${b.geminiHigh ? `; GEMINI_HIGH ${b.geminiHigh.speaker}` : ""}`,
      );
    }
    rows.push(row);

    if (!limitReached()) await sleep(BETWEEN_CALLS_MS);
  }
  return { rows, stop: null };
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

// ── Closed-cast scoring (#354) ──────────────────────────────────────────
/** What the baseline file holds per row; the rest of its Row is unused. */
type OldRow = { bubbleId: string; truth: Triple | null; bench: Triple | null };
const short = (s: string | null | undefined, n = 60) =>
  (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const rowLabel = (r: Row) => `p${r.page} #${r.sortOrder ?? "?"}`;

/** Closed verdict on one row: outside the cast, right, or wrong. */
const closedVerdict = (r: Row) =>
  r.truthId === null
    ? "outside cast"
    : r.replyId === r.truthId
      ? "right"
      : "wrong";

/** The reviewed speakers outside the cast, one line each. */
function outsideLines(rows: Row[]): string[] {
  return rows
    .filter((r) => r.truthId === null)
    .map(
      (r) =>
        `- ${rowLabel(r)} "${short(r.text)}": reviewed speaker ${JSON.stringify(r.truth?.speaker ?? null)} (${r.truth?.type ?? "no type"})`,
    );
}

/** Right on a subset: the reply's cast id equals the truth id `pick` gives. */
function rightOn(rows: Row[], pick: (r: Row) => string | null) {
  const subset = rows.filter((r) => pick(r) !== null);
  const right = subset.filter((r) => r.replyId === pick(r)).length;
  return `${right}/${subset.length}`;
}

/**
 * Row 232's GEMINI_HIGH run scored on this run's in-cast subset (truth ids
 * from `pick`), joined on `bubbleId`. Exact: `matchCastSpeaker` maps the old
 * reply to the truth id. Identity: exact, or `speakerVerdict` with
 * SAME_CHARACTER (row 232's rule) calls the old reply and today's reviewed
 * speaker one character.
 */
function baselineLines(
  rows: Row[],
  pick: (r: Row) => string | null = (r) => r.truthId,
): {
  headline: string;
  detail: string[];
} {
  if (!baselinePath) {
    return {
      headline: "old GEMINI_HIGH baseline not scored: no --baseline",
      detail: [],
    };
  }
  if (!existsSync(baselinePath)) {
    return {
      headline: `old GEMINI_HIGH baseline not scored: ${baselinePath} is missing`,
      detail: [],
    };
  }
  const oldRows = JSON.parse(readFileSync(baselinePath, "utf8")) as OldRow[];
  const old = new Map(oldRows.map((o) => [o.bubbleId, o]));
  const ours = new Set(rows.map((r) => r.bubbleId));
  const inCast = rows.filter((r) => pick(r) !== null);
  const missingOld = inCast.filter((r) => !old.has(r.bubbleId));
  const missingNew = oldRows.filter((o) => !ours.has(o.bubbleId));
  const compared = inCast.filter((r) => old.has(r.bubbleId));
  let exact = 0;
  let identity = 0;
  const drift: string[] = [];
  for (const r of compared) {
    const o = old.get(r.bubbleId)!;
    const oldId = o.bench
      ? matchCastSpeaker(
          contextSpeakerReply({
            type: o.bench.type ?? undefined,
            speaker: o.bench.speaker,
          }),
          cast,
        )?.id
      : undefined;
    const isExact = oldId === pick(r);
    if (isExact) exact++;
    if (isExact || speakerVerdict(r, o.bench, aliased) === "match") identity++;
    if (plain(o.truth?.speaker) !== plain(r.truth?.speaker)) {
      drift.push(
        `- ${rowLabel(r)} "${short(r.text)}": reviewed ${JSON.stringify(o.truth?.speaker ?? null)} then, ${JSON.stringify(r.truth?.speaker ?? null)} now`,
      );
    }
  }
  const n = compared.length;
  const detail: string[] = [];
  if (missingOld.length) {
    detail.push(
      `In-cast bubbles missing from the baseline (${missingOld.length}), left out of its count:`,
      ...missingOld.map(
        (r) => `- ${rowLabel(r)} ${r.bubbleId} "${short(r.text)}"`,
      ),
    );
  }
  if (missingNew.length) {
    detail.push(
      `Baseline bubbles missing from this run (${missingNew.length}):`,
      ...missingNew.map(
        (o) =>
          `- ${o.bubbleId} truth ${JSON.stringify(o.truth?.speaker ?? null)}`,
      ),
    );
  }
  if (drift.length) {
    detail.push(
      `Reviewed speaker changed since the baseline run (${drift.length}); scored against today's:`,
      ...drift,
    );
  }
  return {
    headline: `old GEMINI_HIGH: ${exact}/${n} exact match, ${identity}/${n} by identity${missingOld.length ? ` (${missingOld.length} in-cast bubbles not in the baseline)` : ""}`,
    detail,
  };
}

/** `--dry-run`: everything the run would send and score, before any call. */
function dryRunReport(
  rows: Row[],
  suggestions: { name: string; qualifier: string; source: string }[],
) {
  const out: string[] = [
    `DRY RUN, no model call. Model ${model} via ${provider}, variant ${variant}, cast ${castMode}.${twoCall ? ` Call 1 thinkingLevel: ${speakerThinking ?? "none sent"}; call 2: ${ThinkingLevel.LOW}.` : ""}`,
    `Pages ${pages.join(", ")} of ${book} / ${issue}: ${rows.length} bubbles, ${rows.length} prompts built. A run needs --max-calls ${rows.length} or more (plus retries).`,
    "",
  ];
  if (closed) {
    const lines = closedCastLines(cast, []);
    out.push(
      `Cast (${cast.length} members from proposeCast), as the prompt lists it before the per-page "seen" marks:`,
      ...lines.map((l) => `  ${l}`),
      "",
      "Seen on each page (face detections naming a cast member):",
      ...pages.map(
        (p) => `  p${p}: ${(seenByPage.get(p) ?? []).join(", ") || "(none)"}`,
      ),
      "",
      `proposeCast suggestions (names no characters row knows, not in the cast): ${suggestions.map((s) => `${s.name}${s.qualifier ? ` (${s.qualifier})` : ""} [${s.source}]`).join("; ") || "(none)"}`,
      "",
      "Truth per bubble (reviewed speaker → cast id):",
      ...rows.map(
        (r) =>
          `  ${rowLabel(r).padEnd(8)} ${JSON.stringify(r.truth?.speaker ?? null).padEnd(22)} ${(r.truth?.type ?? "").padEnd(10)} → ${r.truthId ?? "OUTSIDE"}${r.truthId && !r.truthIdStrict ? " (folded)" : ""}  "${short(r.text, 40)}"`,
      ),
      "",
    );
    const outside = outsideLines(rows);
    const strictN = rows.filter((r) => r.truthIdStrict !== null).length;
    const base = baselineLines(rows);
    const strictBase = baselineLines(rows, (r) => r.truthIdStrict);
    out.push(
      `In-cast subset (folded by identity): ${rows.length - outside.length} of ${rows.length}. Strict (matchCastSpeaker only): ${strictN}. Reviewed speaker outside the cast: ${outside.length}.`,
      ...outside,
      ...(outside.length > 15
        ? [
            `owner call: ${outside.length} reviewed speakers land outside the cast (over 15): an alias gap, or truly absent from the issue's cast?`,
          ]
        : []),
      "",
      `On the folded set, ${base.headline}`,
      `On the strict set, ${strictBase.headline}`,
      ...base.detail,
      "",
    );
  }
  out.push(
    `One full prompt (${samplePrompt?.label ?? "none built"}, ${samplePrompt?.images ?? 0} image(s) before it):`,
    "-----",
    samplePrompt?.prompt ?? "(none)",
    "-----",
    ...(twoCall
      ? [
          "One call 2 prompt (built here from the reviewed speaker and emotion; the run sends call 1's):",
          "-----",
          sampleCuePrompt ?? "(none)",
          "-----",
        ]
      : []),
  );
  console.log(`\n${out.join("\n")}`);
}

function writeOutputs(rows: Row[], stops: string[]) {
  mkdirSync(outDir, { recursive: true });
  const slug = model.replace(/[^a-zA-Z0-9]+/g, "-");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(
    outDir,
    `${slug}-${provider}-${source}-${variant}${speakerThinkingArg ? `-think-${speakerThinkingArg}` : ""}${closed ? "-closed" : ""}-${stamp}`,
  );
  writeFileSync(`${base}.json`, JSON.stringify(rows, null, 2));

  const smoke = source === "smoke";
  const withTruth = rows.filter((r) => r.truth);
  const n = withTruth.length;
  const count = (pick: (r: Row) => Triple | null, norm = plain) =>
    withTruth.filter((r) => speakerVerdict(r, pick(r), norm) === "match")
      .length;
  const gem = `GEMINI_HIGH ${count((r) => r.geminiHigh)}/${n} / ${count((r) => r.geminiHigh, aliased)}/${n}, `;
  const bench = `${model} ${count((r) => r.bench)}/${n} / ${count((r) => r.bench, aliased)}/${n}`;
  const costUsd = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const cueCostUsd = rows.reduce((sum, r) => sum + (r.cue?.costUsd ?? 0), 0);
  const cost =
    provider === "gemini" && !priced
      ? "cost not priced"
      : `cost $${costUsd.toFixed(6)}`;
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

  const columns: [string, (r: Row) => string | number | null | undefined][] = [
    ["page", (r) => r.page],
    ["panel", (r) => r.panel],
    ["sort", (r) => r.sortOrder],
    ["bubble", (r) => r.bubbleId.slice(0, 8)],
    ["text", (r) => r.text],
    ["truth speaker", (r) => r.truth?.speaker],
    ["truth emotion", (r) => r.truth?.emotion],
    ["truth type", (r) => r.truth?.type],
    ...(smoke
      ? ([
          ["GEMINI_HIGH speaker", (r) => r.geminiHigh?.speaker],
          ["GEMINI_HIGH emotion", (r) => r.geminiHigh?.emotion],
          ["GEMINI_HIGH type", (r) => r.geminiHigh?.type],
        ] as typeof columns)
      : []),
    ["bench speaker", (r) => r.bench?.speaker],
    ["bench emotion", (r) => r.bench?.emotion],
    ["bench type", (r) => r.bench?.type],
    ["bench textWithCues", (r) => r.bench?.textWithCues],
    ["parsed", (r) => (r.parsed ? "yes" : "no")],
    ["ms", (r) => r.latencyMs],
    ["tokens in/out", (r) => tokenCell(r.usage)],
    ["USD", (r) => r.costUsd?.toFixed(6)],
    ...(smoke
      ? ([
          ["GEMINI_HIGH vs truth", (r) => speakerVerdict(r, r.geminiHigh)],
        ] as typeof columns)
      : []),
    ["bench vs truth", (r) => speakerVerdict(r, r.bench)],
    ...(smoke
      ? ([
          [
            "GEMINI_HIGH vs truth (aliases)",
            (r) => speakerVerdict(r, r.geminiHigh, aliased),
          ],
        ] as typeof columns)
      : []),
    ["bench vs truth (aliases)", (r) => speakerVerdict(r, r.bench, aliased)],
    ...(closed
      ? ([
          ["truth id", (r) => r.truthId ?? "outside cast"],
          ["truth id strict", (r) => r.truthIdStrict],
          ["reply speaker", (r) => r.replySpeaker],
          ["reply id", (r) => r.replyId],
          ["closed verdict", (r) => closedVerdict(r)],
        ] as typeof columns)
      : []),
  ];

  const closedHead: string[] = [];
  if (closed) {
    const inCast = rows.filter((r) => r.truthId !== null);
    const strictN = rows.filter((r) => r.truthIdStrict !== null).length;
    const named = rows.filter(
      (r) => r.parsed && r.replySpeaker?.trim() && r.replyId === null,
    );
    const nulls = rows.filter((r) => r.parsed && !r.replySpeaker?.trim());
    const unparsed = rows.filter((r) => !r.parsed);
    const errors = unparsed.filter((r) => r.rawReply?.startsWith("error:"));
    const outside = outsideLines(rows);
    const baseline = baselineLines(rows);
    const strictBase = baselineLines(rows, (r) => r.truthIdStrict);
    closedHead.push(
      `- Model: ${model}`,
      `- In-cast subset, reviewed labels folded by identity: ${inCast.length} of ${rows.length} bubbles (cast of ${cast.length})`,
      `- Right on the subset: ${rightOn(rows, (r) => r.truthId)}; ${baseline.headline}`,
      `- Strict subset (matchCastSpeaker only, ${strictN} bubbles): right ${rightOn(rows, (r) => r.truthIdStrict)}; ${strictBase.headline}`,
      `- Named outside the list: ${named.length} (ship gate: 0)`,
      `- Null replies: ${nulls.length}`,
      `- Unparsed: ${unparsed.length}${errors.length ? ` (${errors.length} of them API errors)` : ""}`,
      `- Reviewed speaker outside the cast: ${outside.length}`,
      `- ${cost}, median latency ${medianMs ?? "n/a"} ms, ${calls} requests`,
      ...(twoCall
        ? [
            `- two-call: the line above is call 1; call 2 (cues) cost $${cueCostUsd.toFixed(6)}, ${rows.filter((r) => r.cue?.reply).length} cue lines of ${rows.filter((r) => r.cue).length} calls`,
          ]
        : []),
      "",
      ...(named.length
        ? [
            "Named outside the list:",
            ...named.map(
              (r) =>
                `- ${rowLabel(r)} "${short(r.text)}": reply ${JSON.stringify(r.replySpeaker)}, truth ${r.truthId ?? "outside cast"}`,
            ),
            "",
          ]
        : []),
      ...(outside.length
        ? ["Reviewed speaker outside the cast:", ...outside, ""]
        : []),
      ...(baseline.detail.length ? [...baseline.detail, ""] : []),
    );
  }

  const lines = [
    `# Speaker bench: ${model} via ${provider}, variant ${variant}, source ${source}${closed ? ", #354 closed cast" : ""}`,
    "",
    ...closedHead,
    smoke
      ? `Smoke pages ${pages.join(", ")} (\`${SMOKE_BOOK}\` / \`${SMOKE_ISSUE}\`), truth from \`${TRUTH_BOOK}\` / \`${TRUTH_ISSUE}\`.`
      : `Reviewed pages ${pages.join(", ")} of \`${book}\` / \`${issue}\`; each row is its own truth.`,
    "",
    `Totals: ${rows.length} bubbles sent, ${rows.filter((r) => r.parsed).length} replies parsed, ` +
      `speaker matches against truth (plain / with aliases): ${smoke ? gem : ""}${bench}. ` +
      `${cost}, median latency ${medianMs ?? "n/a"} ms. Requests: ${calls}.`,
    ...(stops.length ? ["", `Stopped early: ${stops.join("; ")}`] : []),
    "",
    `| ${columns.map(([name]) => name).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (r) => `| ${columns.map(([, get]) => cell(get(r))).join(" | ")} |`,
    ),
    "",
  ];
  writeFileSync(`${base}.md`, lines.join("\n"));
  console.log(`\nwrote ${base}.json\nwrote ${base}.md`);
  console.log(closed ? closedHead.join("\n") : lines[4]);
}

// ── Main: up to --page-concurrency pages at once, bubbles in series ─────
const bookContext = await loadBookContext(book!, issue!);
let suggestions: { name: string; qualifier: string; source: string }[] = [];
if (closed) {
  ({ cast, suggestions } = await loadClosedCast(book!, issue!));
  if (cast.length === 0) die(`${book}/${issue}: proposeCast returned no cast`);
}
const queue = [...pages];
const results = new Map<number, Row[]>();
const stops: string[] = [];
await Promise.all(
  Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
    while (queue.length > 0 && !halted && !limitReached()) {
      const page = queue.shift()!;
      const { rows, stop } = await runPage(page, bookContext);
      results.set(page, rows);
      if (stop) stops.push(stop);
    }
  }),
);
// Page then sort order, whatever order the pages finished in.
const rows = pages.flatMap((p) =>
  (results.get(p) ?? [])
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        (a.r.sortOrder ?? Infinity) - (b.r.sortOrder ?? Infinity) || a.i - b.i,
    )
    .map(({ r }) => r),
);
if (dryRun) dryRunReport(rows, suggestions);
else writeOutputs(rows, stops);
