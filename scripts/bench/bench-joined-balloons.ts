/**
 * Bench the joined-balloon finder (#451): geometry picks candidate pairs, one
 * GEMINI_FAST call per page says which are joined, and the answers are
 * scored against a hand-made list of joined balloons.
 *
 * Candidates. Bubbles (not `ignored`) in play order: `page_number`, the
 * panel's `sort_order`, then `bubbles.sort_order`. A pair is two bubbles
 * next to each other in that order inside one panel (same `panel_id`). A
 * candidate is such a pair whose boxes overlap or sit within `--gap` px
 * (default 40), edge to edge. Boxes come from `bubbles.style` (percent of the
 * page, set on every bubble, manual ones too) times `pages.width`/`height`.
 * Cross-panel pairs are out of scope.
 *
 * The call. The page image plus the page's candidates (index, the two pixel
 * boxes and `ocr_text`; with `--hint speaker`, each bubble's `character_id`
 * too), JSON mode, thinkingLevel LOW. Reply:
 * `{ "candidates": [{ "index", "joined", "reason" }] }`. A page with no
 * candidate gets no call.
 *
 * Labels: a JSON array of groups `{ "page": 13, "bubbles": [uuid, ...] }` in
 * play order; each consecutive pair in a group is a labeled joined pair (pair
 * order does not matter). A group with a `verdict` other than "J" is skipped.
 * Scores: true joins, false joins (predicted, not labeled), misses (labeled,
 * not predicted, no answer included), and geometry misses (labeled pairs that
 * are not candidates). Recall is over every labeled pair, geometry misses
 * included.
 *
 * Writes one `RunFile` under `--out` (bench-kit.ts): one row per candidate,
 * every same-panel pair with its gap, each page's sent candidates and raw
 * reply, the scores, tokens and USD. `--rescore <run.json>` scores a saved
 * run against the labels file again, with no Supabase read and no call.
 *
 * No Supabase or Storage write. Live runs set DRY_RUN in this process so
 * `generateContentLogged` writes no `llm_calls` row, after the spend guard
 * (LIVE_API_OK=1). Started with DRY_RUN=1, the bench makes no call: the
 * fixture fake has no answer for this prompt, so a stand-in replies "joined"
 * for every candidate whose boxes overlap, in the reply's JSON shape, and the
 * rest of the run (parse, score, run file) is the live path.
 *
 * Usage:
 *   DRY_RUN=1 pnpm exec tsx --env-file=.env scripts/bench/bench-joined-balloons.ts \
 *     --labels <file> [--book tmnt-mmpr-iii --issue issue-1 --pages 3-13]
 *   LIVE_API_OK=1 pnpm exec tsx --env-file=.env scripts/bench/bench-joined-balloons.ts \
 *     --labels <file> [--hint none|speaker] [--gap 40] [--max-calls 11] [--out <dir>]
 *   pnpm exec tsx scripts/bench/bench-joined-balloons.ts --rescore <run.json> [--labels <file>]
 */
import {
  type GenerateContentResponse,
  type GoogleGenAI,
  ThinkingLevel,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { boxFromStyle, gapBetween } from "~/lib/balloon-groups";
import { isDryRun, logSpend } from "~/lib/fakes/dry-run";
import { generateContentLogged } from "~/lib/llm-usage";
import { GEMINI_FAST } from "~/lib/models";
import { pageStoragePath } from "~/lib/storage";
import { createTypedStepClient } from "~/workflows/step-utils";
import {
  type Attempt,
  DEFAULT_OUT,
  type RunFile,
  type ScoredRow,
  benchCli,
  countingClient,
  geminiFromEnv,
  geminiTokens,
  newGate,
  pool,
  refused,
  requireLiveApiOk,
  writeRunFile,
} from "./bench-kit";

const BENCH = "joined-balloons";
/** The `step` on llm meta; no row is written (see the header). */
const STEP = "bench-joined-balloons";
const HINTS = ["none", "speaker"] as const;
type Hint = (typeof HINTS)[number];

const { opt, die, intOpt, oneOf, parsePages, must } = benchCli(
  "bench-joined-balloons",
);

// ── Types ───────────────────────────────────────────────────────────────
type Box = { x: number; y: number; width: number; height: number };

/** Two bubbles next to each other in play order inside one panel. */
type Pair = {
  page: number;
  panel: string;
  a: string;
  b: string;
  /** Edge-to-edge px; 0 when the boxes overlap; null with no box. */
  gap: number | null;
};

type PairRow = ScoredRow & {
  page: number;
  panel: string;
  /** The candidate's index in its page's call. */
  index: number;
  a: string;
  b: string;
  textA: string;
  textB: string;
  gap: number;
  /** Null: the page had no usable reply, or the reply skipped this index. */
  predicted: boolean | null;
  labeled: boolean;
  reason: string | null;
};

type PageCall = {
  page: number;
  /** The candidate list as sent in the prompt. */
  sent: unknown[];
  reply: string | null;
  /** The reply came back but is not the asked-for JSON. */
  failure: string | null;
  /** No reply: the request failed or was not sent. */
  error: string | null;
  modelVersion: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensThinking: number | null;
  costUsd: number | null;
  latencyMs: number | null;
};

type Scores = {
  adjacentPairs: number;
  candidates: number;
  labeledPairs: number;
  trueJoins: number;
  falseJoins: number;
  misses: number;
  noAnswer: number;
  geometryMisses: { page: number; a: string; b: string; why: string }[];
  precision: number | null;
  recall: number | null;
  recallOnCandidates: number | null;
};

type JoinRunFile = RunFile<PairRow> & {
  hint: Hint;
  gapPx: number;
  labels: string;
  pairs: Pair[];
  calls: PageCall[];
  scores: Scores;
  tokens: { input: number; output: number; thinking: number };
  usd: number;
};

type LabelGroup = { page: number; bubbles: string[]; verdict?: string };

// ── Labels and scoring ──────────────────────────────────────────────────
const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function readLabels(path: string, pages: number[]) {
  let groups: LabelGroup[];
  try {
    groups = JSON.parse(readFileSync(path, "utf8")) as LabelGroup[];
  } catch (e) {
    return die(
      `--labels ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(groups)) die(`--labels ${path}: not a JSON array`);
  const labeled = new Map<string, { page: number; a: string; b: string }>();
  for (const g of groups) {
    if (!Number.isInteger(g.page) || !Array.isArray(g.bubbles)) {
      die(`--labels ${path}: a group wants "page" and "bubbles"`);
    }
    if (g.verdict !== undefined && g.verdict !== "J") continue;
    if (!pages.includes(g.page)) continue;
    for (let i = 1; i < g.bubbles.length; i++) {
      const [a, b] = [g.bubbles[i - 1]!, g.bubbles[i]!];
      labeled.set(pairKey(a, b), { page: g.page, a, b });
    }
  }
  return labeled;
}

/** Sets `labeled` and `right` on each row and counts the run. */
function score(
  rows: PairRow[],
  pairs: Pair[],
  labeled: ReturnType<typeof readLabels>,
  gapPx: number,
): Scores {
  const candidateKeys = new Set<string>();
  for (const r of rows) {
    const key = pairKey(r.a, r.b);
    candidateKeys.add(key);
    r.labeled = labeled.has(key);
    r.right = r.predicted === null ? null : r.predicted === r.labeled;
  }
  const pairByKey = new Map(pairs.map((p) => [pairKey(p.a, p.b), p]));
  const geometryMisses = [...labeled]
    .filter(([key]) => !candidateKeys.has(key))
    .map(([key, l]) => {
      const p = pairByKey.get(key);
      const why = !p
        ? "not next to each other in play order inside one panel"
        : p.gap === null
          ? "a bubble has no box"
          : `gap ${p.gap} px > ${gapPx}`;
      return { ...l, why };
    });
  const trueJoins = rows.filter((r) => r.predicted && r.labeled).length;
  const falseJoins = rows.filter((r) => r.predicted && !r.labeled).length;
  const misses = rows.filter((r) => !r.predicted && r.labeled).length;
  const ratio = (n: number, d: number) => (d ? n / d : null);
  return {
    adjacentPairs: pairs.length,
    candidates: rows.length,
    labeledPairs: labeled.size,
    trueJoins,
    falseJoins,
    misses,
    noAnswer: rows.filter((r) => r.predicted === null).length,
    geometryMisses,
    precision: ratio(trueJoins, trueJoins + falseJoins),
    recall: ratio(trueJoins, labeled.size),
    recallOnCandidates: ratio(trueJoins, trueJoins + misses),
  };
}

const pct = (x: number | null) =>
  x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
const yn = (x: boolean | null) => (x === null ? "-" : x ? "yes" : "no");
const cut = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

function report(f: JoinRunFile) {
  const s = f.scores;
  const out = [
    "",
    "page | panel | a -> b | text a | text b | gap | predicted | labeled | reason",
    ...f.rows.map(
      (r) =>
        `p${r.page} | ${r.panel} | ${r.a.slice(0, 8)} -> ${r.b.slice(0, 8)} | ${cut(r.textA)} | ${cut(r.textB)} | ${r.gap} | ${yn(r.predicted)} | ${yn(r.labeled)}${r.predicted !== r.labeled ? " <<" : ""} | ${r.reason ?? "-"}`,
    ),
    "",
    `Geometry misses (labeled, not a candidate): ${s.geometryMisses.length}`,
    ...s.geometryMisses.map((m) => `  p${m.page} ${m.a} -> ${m.b}: ${m.why}`),
    "",
    `${f.book} / ${f.issue}, pages ${f.pages.join(", ")}; ${f.model}, thinking ${f.thinkingLevel ?? "default"}, hint ${f.hint}, gap ${f.gapPx} px; labels ${f.labels}`,
    `Same-panel adjacent pairs ${s.adjacentPairs}, candidates ${s.candidates}, labeled pairs ${s.labeledPairs}.`,
    `True joins ${s.trueJoins}, false joins ${s.falseJoins}, misses ${s.misses} (${s.noAnswer} candidates with no answer), geometry misses ${s.geometryMisses.length}.`,
    `Precision ${pct(s.precision)}, recall ${pct(s.recall)} of all labeled pairs (${pct(s.recallOnCandidates)} of labeled candidates).`,
    `Calls ${f.calls.length} (${f.calls.filter((c) => c.failure).length} unusable replies, ${f.calls.filter((c) => c.error).length} with no reply); tokens ${f.tokens.input} in / ${f.tokens.output} out / ${f.tokens.thinking} thinking; $${f.usd.toFixed(4)}.${f.stop ? ` Stopped early: ${f.stop}` : ""}`,
  ];
  console.log(out.join("\n"));
}

// ── --rescore ───────────────────────────────────────────────────────────
const rescorePath = opt("--rescore");
if (rescorePath) {
  const saved = JSON.parse(readFileSync(rescorePath, "utf8")) as JoinRunFile;
  if (saved.bench !== BENCH) die(`${rescorePath} is not a ${BENCH} run file`);
  const labelsPath = opt("--labels") ?? saved.labels;
  const before = JSON.stringify(saved.scores);
  const rows = saved.rows.map((r) => ({ ...r }));
  const scores = score(
    rows,
    saved.pairs,
    readLabels(labelsPath, saved.pages),
    saved.gapPx,
  );
  report({ ...saved, rows, scores, labels: labelsPath });
  console.log(
    `Rescored ${rescorePath}, no call. Scores ${JSON.stringify(scores) === before ? "match" : "differ from"} the saved run's.`,
  );
  process.exit(0);
}

// ── Args ────────────────────────────────────────────────────────────────
const dryRun = isDryRun();
const book = opt("--book") ?? "tmnt-mmpr-iii";
const issue = opt("--issue") ?? "issue-1";
const pages = parsePages(opt("--pages") ?? "3-13");
const labelsPath = opt("--labels") ?? die("--labels <file> is required");
const hint = oneOf("--hint", HINTS, "none");
const gapPx = intOpt("--gap", 40)!;
const gate = newGate(intOpt("--max-calls", pages.length)!);
const outDir = opt("--out") ?? DEFAULT_OUT;
const labeled = readLabels(labelsPath, pages);
const THINKING = ThinkingLevel.LOW;

let primary: GoogleGenAI | null = null;
if (!dryRun) {
  requireLiveApiOk("gemini", GEMINI_FAST, die);
  primary = geminiFromEnv(die);
  // Under DRY_RUN the Gemini wrapper writes no llm_calls row (see the header).
  process.env.DRY_RUN = "1";
}

const supabase = await createTypedStepClient();

// ── Pages and candidates ────────────────────────────────────────────────
type Bubble = {
  id: string;
  panel: string | null;
  text: string;
  character: string | null;
  box: Box | null;
};
type Page = {
  page: number;
  image: Buffer;
  width: number;
  height: number;
  bubbles: Map<string, Bubble>;
  pairs: Pair[];
  candidates: Pair[];
};

async function loadPages(): Promise<Page[]> {
  const sizes = must(
    await supabase
      .from("pages")
      .select("number, width, height")
      .eq("book_id", book)
      .eq("issue_id", issue)
      .in("number", pages),
    "pages read",
  );
  const out: Page[] = [];
  for (const page of pages) {
    const size = sizes.find((s) => s.number === page);
    if (!size) return die(`page ${page}: no pages row`);
    const panelRows = must(
      await supabase
        .from("panels")
        .select("id, panel_id, sort_order")
        .eq("book_id", book)
        .eq("issue_id", issue)
        .eq("page_number", page),
      `panels read, page ${page}`,
    );
    const bubbleRows = must(
      await supabase
        .from("bubbles")
        .select("id, panel_id, sort_order, ocr_text, character_id, style")
        .eq("book_id", book)
        .eq("issue_id", issue)
        .eq("page_number", page)
        .eq("ignored", false),
      `bubbles read, page ${page}`,
    );
    const { data: blob, error } = await supabase.storage
      .from("comic-pages")
      .download(pageStoragePath(book, issue, page));
    if (error || !blob) {
      return die(
        `page ${page}: image download failed (${error?.message ?? "no data"})`,
      );
    }
    const image = Buffer.from(await blob.arrayBuffer());
    const meta = await sharp(image).metadata();
    if (meta.width !== size.width || meta.height !== size.height) {
      console.warn(
        `p${page}: image is ${meta.width}x${meta.height}, pages row says ${size.width}x${size.height}; boxes use the pages row`,
      );
    }

    const panelOrder = new Map(panelRows.map((p) => [p.id, p.sort_order]));
    const panelName = new Map(panelRows.map((p) => [p.id, p.panel_id]));
    const played = [...bubbleRows].sort(
      (a, b) =>
        (a.panel_id ? (panelOrder.get(a.panel_id) ?? -1) : -1) -
          (b.panel_id ? (panelOrder.get(b.panel_id) ?? -1) : -1) ||
        a.sort_order - b.sort_order,
    );
    const bubbles = new Map(
      played.map((b): [string, Bubble] => [
        b.id,
        {
          id: b.id,
          panel: b.panel_id,
          text: (b.ocr_text ?? "").replace(/\s+/g, " ").trim(),
          character: b.character_id,
          box: boxFromStyle(b.style, size.width, size.height),
        },
      ]),
    );
    const pairs: Pair[] = [];
    for (let i = 1; i < played.length; i++) {
      const [a, b] = [
        bubbles.get(played[i - 1]!.id)!,
        bubbles.get(played[i]!.id)!,
      ];
      if (!a.panel || a.panel !== b.panel) continue;
      pairs.push({
        page,
        panel: panelName.get(a.panel) ?? a.panel.slice(0, 8),
        a: a.id,
        b: b.id,
        gap: a.box && b.box ? gapBetween(a.box, b.box) : null,
      });
    }
    out.push({
      page,
      image,
      width: size.width,
      height: size.height,
      bubbles,
      pairs,
      candidates: pairs.filter((p) => p.gap !== null && p.gap <= gapPx),
    });
  }
  return out;
}

// ── The call ────────────────────────────────────────────────────────────
const prompt = (p: Page, sent: unknown[]) =>
  `You are looking at one comic book page, ${p.width}x${p.height} px.
Below is a list of candidate pairs of balloons or caption boxes. The two in each pair are next to each other in reading order inside one panel, and their boxes touch or sit close. Boxes are page pixels {x, y, width, height}, x and y the top-left corner.

For each candidate, decide whether the two are drawn as ONE joined unit for ONE speaker:
- joined: the outlines touch, overlap or merge, or a short connector line ties them, and the two carry one character's line of dialogue in sequence.
- not joined: two separate balloons that only sit close or overlap, for example two characters talking, or one character's balloons with separate tails at different moments.
Look at the outlines, connectors and tails in the image, not only at the boxes.${
    hint === "speaker"
      ? "\nEach balloon also has the character_id a reviewer gave it. Use it as a hint; one speaker on both does not by itself make them joined."
      : ""
  }

Answer every candidate, by its index, with a reason of one short clause naming what you saw.
Return JSON only: {"candidates": [{"index": <number>, "joined": <true or false>, "reason": "<one clause>"}]}

Candidates:
${JSON.stringify(sent)}`;

function sentList(p: Page): unknown[] {
  const one = (id: string) => {
    const b = p.bubbles.get(id)!;
    const r = b.box!;
    return {
      box: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
      text: b.text,
      ...(hint === "speaker" ? { character_id: b.character } : {}),
    };
  };
  return p.candidates.map((c, index) => ({
    index,
    a: one(c.a),
    b: one(c.b),
  }));
}

/** The reply's verdict per index, or throw naming what is wrong. */
function parseReply(text: string, n: number) {
  const data = JSON.parse(text) as { candidates?: unknown };
  if (!Array.isArray(data?.candidates)) throw new Error("no candidates array");
  const out = new Map<number, { joined: boolean; reason: string }>();
  for (const item of data.candidates as Record<string, unknown>[]) {
    const index = item?.index;
    if (
      !Number.isInteger(index) ||
      (index as number) < 0 ||
      (index as number) >= n
    ) {
      throw new Error(`bad index ${JSON.stringify(index)}`);
    }
    if (typeof item.joined !== "boolean") {
      throw new Error(`index ${index as number}: joined is not a boolean`);
    }
    if (!out.has(index as number)) {
      out.set(index as number, {
        joined: item.joined,
        reason: typeof item.reason === "string" ? item.reason : "",
      });
    }
  }
  return out;
}

/** DRY_RUN's stand-in reply: joined when the boxes overlap. */
function standInReply(p: Page): string {
  logSpend("gemini", "request", 1, `(${STEP}, ${GEMINI_FAST}; stand-in reply)`);
  return JSON.stringify({
    candidates: p.candidates.map((c, index) => ({
      index,
      joined: c.gap === 0,
      reason: `DRY_RUN stand-in: boxes ${c.gap === 0 ? "overlap" : `${c.gap} px apart`}`,
    })),
  });
}

async function findOne(p: Page): Promise<{ call: PageCall; rows: PairRow[] }> {
  const sent = sentList(p);
  const log: Attempt[] = [];
  let reply: string | null = null;
  let error: string | null = null;
  let response: GenerateContentResponse | undefined;
  if (dryRun) {
    // The stand-in draws on the same --max-calls budget, so a dry run
    // exercises the no-verdict path too.
    if (gate.budget.take()) reply = standInReply(p);
    else error = `--max-calls ${gate.budget.max} reached before p${p.page}`;
  } else {
    try {
      response = await generateContentLogged(
        countingClient(primary!, log, gate),
        {
          model: GEMINI_FAST,
          contents: [
            createPartFromBase64(p.image.toString("base64"), "image/webp"),
            createPartFromText(prompt(p, sent)),
          ],
          config: {
            responseMimeType: "application/json",
            thinkingConfig: { thinkingLevel: THINKING },
          },
        },
        { step: STEP, bookId: book, issueId: issue, pageNumber: p.page },
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const ok = log.find((a) => a.status === 200);
    reply = ok?.reply ?? null;
    if (!error && reply === null) error = ok?.error ?? "no reply text";
    const last = log[log.length - 1];
    // A request the API refuses (a bad model or config) stops the run.
    if (refused(last)) gate.halted ??= `HTTP ${last!.status}: ${last!.error}`;
  }
  let verdicts = new Map<number, { joined: boolean; reason: string }>();
  let failure: string | null = null;
  if (reply !== null) {
    try {
      verdicts = parseReply(reply, p.candidates.length);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
  }
  const ok = log.find((a) => a.status === 200);
  const tokens = ok ? geminiTokens(ok.usage) : null;
  const call: PageCall = {
    page: p.page,
    sent,
    reply,
    failure,
    error,
    modelVersion: response?.modelVersion ?? null,
    tokensIn: tokens?.input ?? null,
    tokensOut: tokens?.output ?? null,
    tokensThinking: tokens?.thinking ?? null,
    costUsd: log.reduce((s, a) => s + (a.costUsd ?? 0), 0),
    latencyMs: ok?.latencyMs ?? null,
  };
  return { call, rows: pageRows(p, verdicts) };
}

/** One row per candidate; `predicted` is null where the model gave no verdict. */
function pageRows(
  p: Page,
  verdicts: Map<number, { joined: boolean; reason: string }>,
): PairRow[] {
  return p.candidates.map((c, index): PairRow => {
    const v = verdicts.get(index);
    const a = p.bubbles.get(c.a)!;
    const b = p.bubbles.get(c.b)!;
    return {
      id: pairKey(c.a, c.b),
      label: `p${p.page} ${c.panel} ${c.a.slice(0, 8)} -> ${c.b.slice(0, 8)} "${a.text.slice(0, 40)}" / "${b.text.slice(0, 40)}"`,
      right: null,
      costUsd: null,
      page: p.page,
      panel: c.panel,
      index,
      a: c.a,
      b: c.b,
      textA: a.text,
      textB: b.text,
      gap: c.gap!,
      predicted: v?.joined ?? null,
      labeled: false,
      reason: v?.reason ?? null,
    };
  });
}

// ── Main ────────────────────────────────────────────────────────────────
const startedAt = new Date().toISOString();
const loaded = await loadPages();
const allPairs = loaded.flatMap((p) => p.pairs);
const toSend = loaded.filter((p) => p.candidates.length > 0);
console.log(
  [
    `${dryRun ? "DRY RUN (stand-in replies, no Gemini call). " : ""}${book} / ${issue}, pages ${pages.join(", ")}, gap ${gapPx} px, hint ${hint}.`,
    ...loaded.map(
      (p) =>
        `  p${p.page}: ${p.bubbles.size} bubbles, ${p.pairs.length} same-panel adjacent pairs, ${p.candidates.length} candidates${p.pairs.some((x) => x.gap === null) ? ` (${p.pairs.filter((x) => x.gap === null).length} pairs with no box)` : ""}`,
    ),
    `Same-panel adjacent pairs ${allPairs.length}, candidates ${toSend.reduce((s, p) => s + p.candidates.length, 0)}, calls ${toSend.length} (--max-calls ${gate.budget.max}).`,
  ].join("\n"),
);

const results = await pool(toSend, 4, findOne, () => gate.halted !== null);
const done = results.filter(
  (r): r is Awaited<ReturnType<typeof findOne>> => r !== undefined,
);
// A page the run never reached (--max-calls, or a refused call halting the
// pool) still scores: its candidates get no verdict and count as misses.
const donePages = new Set(done.map((r) => r.call.page));
const rows = [
  ...done.flatMap((r) => r.rows),
  ...toSend
    .filter((p) => !donePages.has(p.page))
    .flatMap((p) => pageRows(p, new Map())),
];
const calls = done.map((r) => r.call);
const tokens = calls.reduce(
  (t, c) => ({
    input: t.input + (c.tokensIn ?? 0),
    output: t.output + (c.tokensOut ?? 0),
    thinking: t.thinking + (c.tokensThinking ?? 0),
  }),
  { input: 0, output: 0, thinking: 0 },
);
const file: JoinRunFile = {
  bench: BENCH,
  arm: `${dryRun ? "dry-" : ""}hint-${hint}`,
  armLabel: `${dryRun ? "DRY_RUN stand-in (overlap = joined)" : "GEMINI_FAST, thinkingLevel LOW"}, hint ${hint}, gap ${gapPx} px`,
  model: dryRun ? "dry-run-stand-in" : GEMINI_FAST,
  thinkingLevel: dryRun ? null : THINKING,
  run: 1,
  runs: 1,
  complete: done.length === toSend.length,
  stop: gate.halted,
  book,
  issue,
  pages,
  startedAt,
  finishedAt: new Date().toISOString(),
  rows,
  hint,
  gapPx,
  labels: labelsPath,
  pairs: allPairs,
  calls,
  scores: score(rows, allPairs, labeled, gapPx),
  tokens,
  usd: calls.reduce((s, c) => s + (c.costUsd ?? 0), 0),
};
report(file);
console.log(`wrote ${writeRunFile(outDir, file)}`);
