/**
 * Bench the reading order call (`sort-page-elements`) on three arms (#443),
 * against the stored `panels.sort_order` and `bubbles.sort_order` of
 * `tmnt-mmpr-iii` / `issue-1` pages 3 to 13.
 *
 * Each page is sent the way `sortPageElements` sends it, through the real
 * code in src/workflows/steps/sort.ts: `pageHandles`, `sortPrompt`,
 * `sortPlanRequest` (page image, prompt, model; the step's request) sent
 * through `generateContentLogged` as the step sends it, and
 * `sortPlanFromResponse` (parse, handles back to UUIDs, the step's own
 * validation). The bench passes only the arm's model and thinking level. A
 * page production gives the free heuristic (`takesHeuristicSort`: no panel,
 * or a lone full-page panel) is not sent.
 *
 * Input order (the leak guard). The stored rows hold the answer: their
 * `panel_id` (`p03-02`) and `legacy_id` (`page-03_b02`) numbers equal their
 * `sort_order` on these pages, and the prompt shows each panel's
 * `current_sort_order` and numbers its handles in input order. On a first
 * ingest the step reads rows in Roboflow detection order with
 * `sort_order` = detection index (`mapPanelRows`, `mapBubbleRows`), which is
 * not reading order (smoke-test: `p01-04` reads first). That order is gone
 * for these rows, so the bench feeds panels and bubbles by UUID `id`
 * (random v4) and sets each fed row's `sort_order` to its index in that
 * order, which is what a first ingest's `current_sort_order` is. `--dry-run`
 * prints what an echo of the fed order would score, as the check.
 *
 * Scoring, per page and run, in memory. "Out of place":
 * - a panel is out of place when its index in the reply's panel order (the
 *   step's `panelOrders`) differs from its index in the stored order (by
 *   `sort_order`, then `id`, the step's read order);
 * - a bubble is out of place when the reply puts it in a different panel
 *   than its stored `panel_id`, or its index among that panel's bubbles in
 *   the reply (by `sortOrder`, as the step flattens them) differs from its
 *   index among the panel's stored bubbles (by `sort_order`, then `id`).
 * A page is fully right when no panel and no bubble is out of place. The
 * global play order is not scored: on pages 3 and 8 the stored play order
 * steps back to an earlier panel, which the step's panel-by-panel flatten
 * can never write. A reply the step's validation rejects (no text, bad JSON,
 * an unknown, duplicate or dropped id) is a failed reply: every item on the
 * page is wrong. A request with no reply (an HTTP error) leaves the page's
 * items unscored. A bubble with no stored `panel_id` is unscored.
 *
 * Rows: one per panel and per bubble (`right` as above), so
 * `compare-runs.ts` flips and sign-tests items; plus one `page` row per page
 * (`right: null`, never scored) that carries the call: tokens, cost,
 * latency, the reply, what was sent, and the page verdict.
 *
 * Arms: A is GEMINI_MEDIUM with no thinking level (production's call before
 * #443), B is GEMINI_FAST with no thinking level, C is GEMINI_FAST at
 * thinkingLevel LOW (production's call since, decisions row 295).
 * `--arm all` is A and B; C runs only when named (`--arm C`, `--arm A,B,C`).
 *
 * Writes: one `RunFile` per arm and run under `--out` (bench-kit.ts). No
 * Supabase write: the bench reads rows and the page image and never reaches
 * the step's write path. DRY_RUN is set in this process so
 * `generateContentLogged` writes no `llm_calls` row; the Gemini client is the
 * bench's own, on the real API. Paid: runs only under LIVE_API_OK=1.
 *
 * Usage:
 *   pnpm exec tsx --env-file=.env scripts/bench/bench-reading-order.ts --dry-run
 *   LIVE_API_OK=1 pnpm exec tsx --env-file=.env scripts/bench/bench-reading-order.ts \
 *     [--arm A|B|C|A,B,C|all] [--runs 3] [--max-calls 70] [--max-usd n] \
 *     [--concurrency 1] [--book tmnt-mmpr-iii --issue issue-1] [--pages 3-13] \
 *     [--out <dir>, default ~/comic-reader-bench]
 * Then: pnpm exec tsx scripts/bench/compare-runs.ts --bench reading-order
 */
import {
  type GenerateContentResponse,
  type GoogleGenAI,
  ThinkingLevel,
} from "@google/genai";
import sharp from "sharp";
import { generateContentLogged } from "~/lib/llm-usage";
import { GEMINI_FAST, GEMINI_MEDIUM } from "~/lib/models";
import { pageStoragePath } from "~/lib/storage";
import { createTypedStepClient } from "~/workflows/step-utils";
import {
  type SortBubbleRow,
  type SortPanelRow,
  pageHandles,
  sortPlanFromResponse,
  sortPlanRequest,
  sortPrompt,
  takesHeuristicSort,
} from "~/workflows/steps/sort";
import {
  type Arm,
  type Attempt,
  CallBudget,
  DEFAULT_OUT,
  type Gate,
  type RunFile,
  type ScoredRow,
  benchCli,
  countingClient,
  geminiFromEnv,
  geminiRate,
  geminiTokens,
  geminiUsd,
  median,
  pickArms,
  pool,
  refused,
  requireLiveApiOk,
  tierOf,
  writeRunFile,
} from "./bench-kit";

const BENCH = "reading-order";
/** The `step` on llm meta; no row is written under DRY_RUN. */
const STEP = "bench-reading-order";
const ARMS: Arm[] = [
  {
    name: "A",
    label: "GEMINI_MEDIUM, no thinking level (before #443)",
    model: GEMINI_MEDIUM,
  },
  {
    name: "B",
    label: "GEMINI_FAST, no thinking level",
    model: GEMINI_FAST,
  },
  {
    name: "C",
    label: "GEMINI_FAST, thinkingLevel LOW (production)",
    model: GEMINI_FAST,
    thinkingLevel: ThinkingLevel.LOW,
  },
];
/** The measured `llm_calls` rows the dry-run estimate reads. */
const MEASURED = {
  bookId: "smoke-test",
  step: "sort-page-elements",
  model: GEMINI_MEDIUM,
  from: "2026-10-05T00:00:00Z",
  to: "2026-10-06T00:00:00Z",
};
/** Consecutive pages with no reply that end the whole invocation. */
const MAX_ERRORS_IN_A_ROW = 3;

// ── Args ────────────────────────────────────────────────────────────────
const { opt, flag, die, intOpt, parsePages, must } = benchCli(
  "bench-reading-order",
);
const dryRun = flag("--dry-run");
const armArg = opt("--arm") ?? "all";
const arms = pickArms(ARMS, armArg === "all" ? "A,B" : armArg, die);
const runs = intOpt("--runs", 3)!;
const gate: Gate = {
  budget: new CallBudget(intOpt("--max-calls", 70)!),
  halted: null,
};
const maxUsdRaw = opt("--max-usd");
const maxUsd = maxUsdRaw === undefined ? undefined : Number(maxUsdRaw);
if (maxUsd !== undefined && !(maxUsd > 0)) die("--max-usd wants a USD amount");
const concurrency = intOpt("--concurrency", 1)!;
const book = opt("--book") ?? "tmnt-mmpr-iii";
const issue = opt("--issue") ?? "issue-1";
const pages = parsePages(opt("--pages") ?? "3-13");
const outDir = opt("--out") ?? DEFAULT_OUT;

let primary: GoogleGenAI | null = null;
if (!dryRun) {
  for (const a of arms) requireLiveApiOk("gemini", a.model, die);
  // The step uses one client and no fallback key; so does the bench.
  primary = geminiFromEnv(die);
}

const supabase = await createTypedStepClient();

// ── Pages and the answer key ────────────────────────────────────────────
type Page = {
  page: number;
  image: Buffer;
  imgW: number;
  imgH: number;
  /** Rows as the prompt gets them: UUID order, `sort_order` = that index. */
  panels: SortPanelRow[];
  bubbles: SortBubbleRow[];
  /** Stored order: panel id → index on the page. */
  keyPanel: Map<string, number>;
  /** Stored order: bubble id → its panel and index within that panel. */
  keyBubble: Map<string, { panel: string | null; index: number }>;
  panelName: Map<string, string>;
  bubbleName: Map<string, string>;
  bubbleText: Map<string, string>;
};

const byStored = <T extends { id: string; sort_order: number }>(a: T, b: T) =>
  a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byId = <T extends { id: string }>(a: T, b: T) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

async function loadPages() {
  const sent: Page[] = [];
  const perPage: string[] = [];
  for (const page of pages) {
    const panelRows = must(
      await supabase
        .from("panels")
        .select("id, panel_id, page_number, sort_order, bounding_box, source")
        .eq("book_id", book)
        .eq("issue_id", issue)
        .eq("page_number", page),
      `panels read, page ${page}`,
    ) as SortPanelRow[];
    const bubbleRows = must(
      await supabase
        .from("bubbles")
        .select(
          "id, legacy_id, panel_id, sort_order, ocr_text, text_with_cues, ignored, box_2d, style",
        )
        .eq("book_id", book)
        .eq("issue_id", issue)
        .eq("page_number", page),
      `bubbles read, page ${page}`,
    ) as SortBubbleRow[];
    const counts = `${panelRows.length} panels, ${bubbleRows.length} bubbles`;
    const { noDetectedPanels, onlyFullPage } = takesHeuristicSort(panelRows);
    if (noDetectedPanels) {
      perPage.push(
        `p${page}: ${counts}; ${onlyFullPage ? "lone full-page panel" : "no panel"}, production sorts it by heuristic with no Gemini call: not sent`,
      );
      continue;
    }

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

    const keyPanel = new Map(
      [...panelRows].sort(byStored).map((p, i) => [p.id, i]),
    );
    const keyBubble = new Map<
      string,
      { panel: string | null; index: number }
    >();
    const within = new Map<string | null, number>();
    for (const b of [...bubbleRows].sort(byStored)) {
      const i = within.get(b.panel_id) ?? 0;
      within.set(b.panel_id, i + 1);
      keyBubble.set(b.id, { panel: b.panel_id, index: i });
    }
    const noPanel = bubbleRows.filter((b) => !b.panel_id).length;
    sent.push({
      page,
      image,
      imgW: meta.width ?? 0,
      imgH: meta.height ?? 0,
      panels: [...panelRows]
        .sort(byId)
        .map((p, i) => ({ ...p, sort_order: i })),
      bubbles: [...bubbleRows]
        .sort(byId)
        .map((b, i) => ({ ...b, sort_order: i })),
      keyPanel,
      keyBubble,
      panelName: new Map(panelRows.map((p) => [p.id, p.panel_id])),
      bubbleName: new Map(
        bubbleRows.map((b) => [b.id, b.legacy_id ?? b.id.slice(0, 8)]),
      ),
      bubbleText: new Map(
        bubbleRows.map((b) => [
          b.id,
          (b.text_with_cues ?? b.ocr_text ?? "").trim().slice(0, 40),
        ]),
      ),
    });
    perPage.push(
      `p${page}: ${counts}${noPanel ? ` (${noPanel} with no panel_id, unscored)` : ""}; sent`,
    );
  }
  return { sent, perPage };
}

// ── Scoring ─────────────────────────────────────────────────────────────
/** What a reply says, in the terms the definitions in the header use. */
type Placement = {
  panelIndex: Map<string, number>;
  bubble: Map<string, { panel: string; index: number }>;
};

type ItemVerdict =
  | "in place"
  | "out of place"
  | "failed"
  | "error"
  | "unscored";

type Item = {
  id: string;
  kind: "panel" | "bubble";
  label: string;
  verdict: ItemVerdict;
  keyPanel: string | null;
  keyIndex: number;
  replyPanel: string | null;
  replyIndex: number | null;
};

/** The reply's placement, from the step's validated plan. */
function placementOf(r: ReturnType<typeof sortPlanFromResponse>): Placement {
  const bubble = new Map<string, { panel: string; index: number }>();
  for (const entry of r.plan.panels) {
    // The step's flatten: a stable sort on sortOrder within the panel.
    [...(entry.bubbles ?? [])]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .forEach((b, index) =>
        bubble.set(b.bubbleId, { panel: entry.panelId, index }),
      );
  }
  return { panelIndex: r.panelOrders, bubble };
}

/** A reply that returns the fed order unchanged: the leak check. */
function echoPlacement(p: Page): Placement {
  const within = new Map<string | null, number>();
  const bubble = new Map<string, { panel: string; index: number }>();
  for (const b of p.bubbles) {
    if (!b.panel_id) continue;
    const i = within.get(b.panel_id) ?? 0;
    within.set(b.panel_id, i + 1);
    bubble.set(b.id, { panel: b.panel_id, index: i });
  }
  return { panelIndex: new Map(p.panels.map((x, i) => [x.id, i])), bubble };
}

/** Every panel and bubble on the page against the stored order. */
function scorePage(
  p: Page,
  placement: Placement | null,
  failure: "failed" | "error" | null,
): Item[] {
  const items: Item[] = [];
  for (const [id, keyIndex] of [...p.keyPanel].sort((a, b) => a[1] - b[1])) {
    const at = placement?.panelIndex.get(id) ?? null;
    items.push({
      id,
      kind: "panel",
      label: `p${p.page} panel ${p.panelName.get(id)} (#${keyIndex + 1})`,
      verdict: failure ?? (at === keyIndex ? "in place" : "out of place"),
      keyPanel: null,
      keyIndex,
      replyPanel: null,
      replyIndex: at,
    });
  }
  const keyed = [...p.keyBubble].sort(
    (a, b) =>
      (p.keyPanel.get(a[1].panel ?? "") ?? -1) -
        (p.keyPanel.get(b[1].panel ?? "") ?? -1) || a[1].index - b[1].index,
  );
  for (const [id, key] of keyed) {
    const at = placement?.bubble.get(id) ?? null;
    const panelName = key.panel ? p.panelName.get(key.panel) : "no panel";
    items.push({
      id,
      kind: "bubble",
      label: `p${p.page} bubble ${p.bubbleName.get(id)} in ${panelName} (#${key.index + 1}) "${p.bubbleText.get(id)}"`,
      verdict:
        key.panel === null
          ? "unscored"
          : (failure ??
            (at && at.panel === key.panel && at.index === key.index
              ? "in place"
              : "out of place")),
      keyPanel: key.panel,
      keyIndex: key.index,
      replyPanel: at?.panel ?? null,
      replyIndex: at?.index ?? null,
    });
  }
  return items;
}

const fullyRight = (items: Item[]) =>
  items.every((i) => i.verdict === "in place" || i.verdict === "unscored");

// ── One page ────────────────────────────────────────────────────────────
type OrderRow = ScoredRow & {
  arm: string;
  run: number;
  page: number;
  kind: "panel" | "bubble" | "page";
  /** Item rows: the item's verdict. Page row: the page's. */
  verdict: ItemVerdict | "fully right" | "not fully right";
  keyPanel: string | null;
  keyIndex: number | null;
  replyPanel: string | null;
  replyIndex: number | null;
  /** Page row only, from here down. */
  failure: string | null;
  /** The step's validation found an id missing from the reply. */
  droppedId: boolean;
  reply: string | null;
  requestModel: string | null;
  requestThinkingLevel: string | null;
  /** The reply's `modelVersion`: which model answered. */
  modelVersion: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensThinking: number | null;
  latencyMs: number | null;
  attempts: number;
  error: string | null;
};

let spentUsd = 0;

async function sortOne(
  arm: Arm,
  run: number,
  p: Page,
): Promise<OrderRow[] | null> {
  const log: Attempt[] = [];
  const handles = pageHandles(p.panels, p.bubbles);
  let error: string | null = null;
  let failure: string | null = null;
  let placement: Placement | null = null;
  let response: GenerateContentResponse | undefined;
  try {
    response = await generateContentLogged(
      countingClient(primary!, log, gate),
      sortPlanRequest(
        p.image,
        sortPrompt(p.imgW, p.imgH, p.panels, p.bubbles, handles),
        // null, not undefined: unset would take production's LOW.
        { model: arm.model, thinkingLevel: arm.thinkingLevel ?? null },
      ),
      { step: STEP, bookId: book, issueId: issue, pageNumber: p.page },
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (response) {
    try {
      placement = placementOf(
        sortPlanFromResponse(response, p.panels, p.bubbles, handles),
      );
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
  }
  // A page that never reached the API (the ceiling, a halt) is left out.
  if (log.length === 0) return null;

  const last = log[log.length - 1]!;
  if (error && refused(last)) {
    // A request the API refuses (a bad model or config): stop everything.
    gate.halted ??= `HTTP ${last.status}: ${last.error}`;
  }
  const ok = [...log].reverse().find((a) => a.reply !== null);
  const cost = log.reduce(
    (s, a) => s + (geminiUsd(a.usage, geminiRate(arm.model)) ?? 0),
    0,
  );
  spentUsd += cost;
  const tokens = ok ? geminiTokens(ok.usage) : null;
  const items = scorePage(
    p,
    placement,
    !response ? "error" : failure ? "failed" : null,
  );
  const base = {
    arm: arm.name,
    run,
    page: p.page,
    failure: null,
    droppedId: false,
    reply: null,
    requestModel: null,
    requestThinkingLevel: null,
    modelVersion: null,
    tokensIn: null,
    tokensOut: null,
    tokensThinking: null,
    latencyMs: null,
    attempts: 0,
    error: null,
    costUsd: null,
  };
  const pageRow: OrderRow = {
    ...base,
    id: `page-${p.page}`,
    label: `p${p.page} page`,
    // A page row is the call record, never scored.
    right: null,
    kind: "page",
    verdict:
      response && !failure && fullyRight(items)
        ? "fully right"
        : "not fully right",
    keyPanel: null,
    keyIndex: null,
    replyPanel: null,
    replyIndex: null,
    failure,
    droppedId: failure?.startsWith("Missing ") ?? false,
    reply: ok?.reply ?? null,
    requestModel: last.model,
    requestThinkingLevel: last.thinkingLevel,
    modelVersion: response?.modelVersion ?? null,
    tokensIn: tokens?.input ?? null,
    tokensOut: tokens?.output ?? null,
    tokensThinking: tokens?.thinking ?? null,
    latencyMs: ok?.latencyMs ?? null,
    attempts: log.length,
    error,
    costUsd: cost,
  };
  return [
    pageRow,
    ...items.map(
      (i): OrderRow => ({
        ...base,
        id: i.id,
        label: i.label,
        right:
          i.verdict === "error" || i.verdict === "unscored"
            ? null
            : i.verdict === "in place",
        kind: i.kind,
        verdict: i.verdict,
        keyPanel: i.keyPanel,
        keyIndex: i.keyIndex,
        replyPanel: i.replyPanel,
        replyIndex: i.replyIndex,
      }),
    ),
  ];
}

// ── Output ──────────────────────────────────────────────────────────────
const usd = (n: number) => `$${n.toFixed(4)}`;
const per = (total: number, n: number) => (n ? Math.round(total / n) : 0);

function counts(rows: OrderRow[]) {
  const n = (kind: OrderRow["kind"], v: OrderRow["verdict"]) =>
    rows.filter((r) => r.kind === kind && r.verdict === v).length;
  const scored = (kind: OrderRow["kind"]) =>
    rows.filter((r) => r.kind === kind && r.right !== null).length;
  return {
    pagesRight: n("page", "fully right"),
    panelsOut: n("panel", "out of place"),
    panelsScored: scored("panel"),
    bubblesOut: n("bubble", "out of place"),
    bubblesScored: scored("bubble"),
  };
}

function summary(arm: Arm, run: number, rows: OrderRow[]): string {
  const calls = rows.filter((r) => r.kind === "page");
  const ok = calls.filter((r) => r.tokensIn !== null);
  const sum = (pick: (r: OrderRow) => number | null) =>
    ok.reduce((s, r) => s + (pick(r) ?? 0), 0);
  const cost = calls.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const failed = calls.filter((r) => r.failure !== null);
  const c = counts(rows);
  return [
    `Arm ${arm.name} run ${run}/${runs} (${tierOf(arm.model) ?? arm.model} ${arm.model}, thinking ${arm.thinkingLevel ?? "default"}):`,
    `pages fully right ${c.pagesRight}/${calls.length},`,
    `panels out of place ${c.panelsOut}/${c.panelsScored},`,
    `bubbles out of place ${c.bubblesOut}/${c.bubblesScored},`,
    `failed replies ${failed.length} (${failed.filter((r) => r.droppedId).length} dropped an id),`,
    `no reply ${calls.filter((r) => r.error !== null).length};`,
    `per call ${per(
      sum((r) => r.tokensIn),
      ok.length,
    )} in / ${per(
      sum((r) => r.tokensOut),
      ok.length,
    )} out / ${per(
      sum((r) => r.tokensThinking),
      ok.length,
    )} thinking tokens;`,
    `cost ${usd(cost)} (${ok.length ? `$${(cost / ok.length).toFixed(5)}` : "n/a"} a call);`,
    `median latency ${median(calls.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs]))) ?? "n/a"} ms;`,
    `${calls.reduce((s, r) => s + r.attempts, 0)} requests for ${calls.length} pages.`,
  ].join(" ");
}

/** `--dry-run`: counts, the echo check, and the estimate from measured rows. */
async function dryRunReport(sent: Page[], perPage: string[]) {
  const n = sent.length;
  const calls = n * runs;
  const echo = sent.map((p) => scorePage(p, echoPlacement(p), null));
  const echoItems = echo.flat();
  const echoOut = (kind: Item["kind"]) =>
    echoItems.filter((i) => i.kind === kind && i.verdict === "out of place")
      .length;
  const of = (kind: Item["kind"]) =>
    echoItems.filter((i) => i.kind === kind && i.verdict !== "unscored").length;
  const out: string[] = [
    `DRY RUN, no Gemini call. ${book} / ${issue}, pages ${pages.join(", ")}.`,
    ...perPage.map((l) => `  ${l}`),
    `Sent: ${n} pages, ${of("panel")} panels, ${of("bubble")} scored bubbles. Rows go in by UUID, sort_order rewritten to that index (see the header).`,
    `Leak check, a reply that echoes the fed order: ${echo.filter(fullyRight).length}/${n} pages fully right, ${echoOut("panel")}/${of("panel")} panels and ${echoOut("bubble")}/${of("bubble")} bubbles out of place.`,
    `Calls: one per sent page, ${n} per arm and run, ${calls} per arm for ${runs} run(s), ${calls * arms.length} for arms ${arms.map((a) => a.name).join(", ")}. That needs --max-calls ${calls * arms.length} or more.`,
    "",
  ];
  const rows = must(
    await supabase
      .from("llm_calls")
      .select(
        "model, tokens_in, tokens_out, tokens_thinking, usd_est, duration_ms",
      )
      .eq("provider", "gemini")
      .eq("book_id", MEASURED.bookId)
      .eq("step", MEASURED.step)
      .eq("model", MEASURED.model)
      .eq("ok", true)
      .gte("created_at", MEASURED.from)
      .lt("created_at", MEASURED.to),
    "llm_calls read",
  );
  if (rows.length === 0) {
    out.push(
      `No llm_calls rows for ${MEASURED.step} on ${MEASURED.model} (${MEASURED.bookId}, ${MEASURED.from} to ${MEASURED.to}): no estimate.`,
    );
    console.log(`\n${out.join("\n")}`);
    return;
  }
  const mean = (pick: (r: (typeof rows)[number]) => number | null) =>
    rows.reduce((s, r) => s + (pick(r) ?? 0), 0) / rows.length;
  const m = {
    input: mean((r) => r.tokens_in),
    output: mean((r) => r.tokens_out),
    thinking: mean((r) => r.tokens_thinking),
  };
  const thinkingSeen = rows.map((r) => r.tokens_thinking ?? 0);
  const callUsd = (
    model: string,
    t: { input: number; output: number; thinking: number },
  ) =>
    geminiUsd(
      {
        promptTokenCount: t.input,
        candidatesTokenCount: t.output,
        thoughtsTokenCount: t.thinking,
      },
      geminiRate(model),
    ) ?? Number.NaN;
  const usdSum = rows.reduce((s, r) => s + Number(r.usd_est ?? 0), 0);
  out.push(
    `Measured: ${rows.length} ${MEASURED.step} llm_calls rows on ${MEASURED.model} (${MEASURED.bookId}, ${MEASURED.from.slice(0, 10)}): ${Math.round(m.input)} in, ${Math.round(m.output)} out, ${Math.round(m.thinking)} thinking tokens a call (mean; thinking ${Math.min(...thinkingSeen)} to ${Math.max(...thinkingSeen)}), usd_est $${usdSum.toFixed(5)} in all, ${Math.round(mean((r) => r.duration_ms))} ms a call (mean).`,
    "Those are smoke-test pages; input tokens grow with the bubble count, so pages here with more bubbles run a little higher.",
    "",
    `Estimate, ${calls} calls per arm:`,
  );
  let lo = 0;
  let hi = 0;
  for (const a of arms) {
    const tier = `${tierOf(a.model) ?? a.model} ${a.model}`;
    if (a.model === GEMINI_MEDIUM && !a.thinkingLevel) {
      const c = callUsd(a.model, m);
      lo += c * calls;
      hi += c * calls;
      out.push(
        `  ${a.name} (${tier}, default thinking): $${(c * calls).toFixed(2)} at $${c.toFixed(5)} a call. Measured tokens, priced at ${tier}'s rate.`,
      );
    } else if (!a.thinkingLevel) {
      const c = callUsd(a.model, { ...m, thinking: 0 });
      lo += c * calls;
      hi += c * calls;
      out.push(
        `  ${a.name} (${tier}, default thinking): $${(c * calls).toFixed(2)} at $${c.toFixed(5)} a call. A guess: no sort-page-elements llm_calls row exists on ${a.model}; the measured input and output tokens, 0 thinking (its default, minimal, thought 0 tokens on the speaker call in #431), at ${tier}'s rate.`,
      );
    } else {
      const floor = callUsd(a.model, { ...m, thinking: 0 });
      const ceil = callUsd(a.model, m);
      lo += floor * calls;
      hi += ceil * calls;
      out.push(
        `  ${a.name} (${tier}, thinking ${a.thinkingLevel}): $${(floor * calls).toFixed(2)} to $${(ceil * calls).toFixed(2)}. A guess: the measured input and output tokens, thinking from 0 up to the measured ${Math.round(m.thinking)} a call, at ${tier}'s rate.`,
      );
    }
  }
  out.push(`  Total: $${lo.toFixed(2)} to $${hi.toFixed(2)}.`);
  console.log(`\n${out.join("\n")}`);
}

// ── Main ────────────────────────────────────────────────────────────────
const { sent, perPage } = await loadPages();
if (sent.length === 0)
  die(`${book}/${issue}: no page to send on pages ${pages.join(", ")}`);
if (dryRun) {
  await dryRunReport(sent, perPage);
  process.exit(0);
}

// Under DRY_RUN the Gemini wrapper writes no llm_calls row (see the header).
process.env.DRY_RUN = "1";
console.log(
  `${sent.length} pages; arms ${arms.map((a) => a.name).join(", ")}; ${runs} run(s); --max-calls ${gate.budget.max}${maxUsd !== undefined ? `; --max-usd ${maxUsd}` : ""}; concurrency ${concurrency}`,
);
const written: string[] = [];
const summaries: string[] = [];
for (let run = 1; run <= runs && !gate.halted; run++) {
  for (const arm of arms) {
    if (gate.halted) break;
    const startedAt = new Date().toISOString();
    let errorsInARow = 0;
    const perPageRows = await pool(
      sent,
      concurrency,
      async (p, i) => {
        const rows = await sortOne(arm, run, p);
        if (rows) {
          const call = rows[0]!;
          errorsInARow = call.error ? errorsInARow + 1 : 0;
          if (errorsInARow >= MAX_ERRORS_IN_A_ROW) {
            gate.halted ??= `${MAX_ERRORS_IN_A_ROW} pages in a row with no reply (last: ${call.error})`;
          }
          if (maxUsd !== undefined && spentUsd >= maxUsd) {
            gate.halted ??= `--max-usd ${maxUsd} reached ($${spentUsd.toFixed(4)})`;
          }
          const c = counts(rows);
          console.log(
            `[${arm.name}${run} ${i + 1}/${sent.length}] p${p.page} → ${call.verdict}, panels out ${c.panelsOut}/${c.panelsScored}, bubbles out ${c.bubblesOut}/${c.bubblesScored} (${call.latencyMs ?? "-"} ms, ${call.tokensThinking ?? "-"} thinking)${call.failure ? ` failed: ${call.failure}` : ""}${call.error ? ` error: ${call.error}` : ""}`,
          );
        }
        return rows;
      },
      () => gate.halted !== null,
    );
    const done = perPageRows.filter((r): r is OrderRow[] => r != null);
    const rows = done.flat();
    const file: RunFile<OrderRow> = {
      bench: BENCH,
      arm: arm.name,
      armLabel: arm.label,
      model: arm.model,
      thinkingLevel: arm.thinkingLevel ?? null,
      run,
      runs,
      complete: done.length === sent.length,
      stop: gate.halted,
      book,
      issue,
      pages,
      startedAt,
      finishedAt: new Date().toISOString(),
      rows,
    };
    written.push(writeRunFile(outDir, file));
    const line = summary(arm, run, rows);
    summaries.push(line);
    console.log(`\n${line}\nwrote ${written[written.length - 1]}\n`);
  }
}
console.log(
  [
    "",
    ...summaries,
    "",
    `Requests ${gate.budget.calls}, spent $${spentUsd.toFixed(4)}.${gate.halted ? ` Stopped early: ${gate.halted}` : ""}`,
  ].join("\n"),
);
