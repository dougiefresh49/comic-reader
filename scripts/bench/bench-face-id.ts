/**
 * Bench lookahead's face ID call on three arms (#441), against the reviewed
 * face detections of `tmnt-mmpr-iii` / `issue-1` pages 3 to 13.
 *
 * Each detection is sent the way the character-lookahead step sends it:
 * `loadLookaheadPageOrFatal` cuts the page's crops from its stored
 * `page_segmentation` row, and `identifyLookaheadFacesOrFatal` names one
 * crop with the real `identifyFace` (prompt, known-character list, wiki
 * synopsis, page image, parse, `faceOutcome`, `resolveCharacterId`). The
 * bench passes only the arm's model and thinking level into `identifyFace`.
 * Each stored `panel_character_detections` row is matched to the crop it
 * was cut from (same panel, same panel-local box); the row's reviewed
 * `character_id` (`human_verified`) is the truth.
 *
 * Exemplars: none are sent. Production looks up the three nearest stored
 * exemplars by the crop's embedding; here that would mean a paid embedding
 * per crop (which writes an `llm_calls` row) and exemplars cut from these
 * very faces. The bench stubs the embedding and the lookup instead, so every
 * arm gets the same prompt with no "Confirmed character examples" block.
 *
 * Arms: A is GEMINI_MEDIUM with no thinking level (production's call before
 * #441), B is GEMINI_MEDIUM at thinkingLevel LOW (production's call since,
 * decisions row 294), C is GEMINI_FAST with no thinking level, D is GEMINI_FAST
 * at thinkingLevel MEDIUM (#450; runs only when named). `--arm all` is A, B
 * and C, interleaved run by run (A1 B1 C1 A2 ...).
 *
 * Writes: one `RunFile` per arm and run under `--out` (bench-kit.ts), rows
 * per detection. No Supabase write. DRY_RUN is set in this process so
 * `generateContentLogged` writes no `llm_calls` row (as the speaker bench
 * writes none); the Gemini client is the bench's own, on the real API, so
 * DRY_RUN's fakes are never used. Paid: runs only under LIVE_API_OK=1.
 *
 * `--dry-run` makes no Gemini call: it loads and matches the detections and
 * prints the counts and a cost estimate from the face ID `llm_calls` rows of
 * run wrun_01M458NQZ6TG3XPD7SGATD2V4J.
 *
 * Usage:
 *   pnpm exec tsx --env-file=.env scripts/bench/bench-face-id.ts --dry-run
 *   LIVE_API_OK=1 pnpm exec tsx --env-file=.env scripts/bench/bench-face-id.ts \
 *     [--arm A|B|C|D|A,B|all] [--skip-unmatched] [--runs 3] [--max-calls 40] [--max-usd n] \
 *     [--concurrency 1] [--book tmnt-mmpr-iii --issue issue-1] [--pages 3-13] \
 *     [--out <dir>, default ~/comic-reader-bench]
 * Then: pnpm exec tsx --env-file=.env scripts/bench/compare-runs.ts --bench face-id
 */
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import sharp from "sharp";
import * as characterIdentification from "~/lib/character-identification";
import * as exemplarStore from "~/lib/exemplar-store";
import type { FaceCropResult } from "~/lib/face-extraction";
import * as faceExtraction from "~/lib/face-extraction";
import * as geminiClientLib from "~/lib/gemini-client";
import * as llmUsage from "~/lib/llm-usage";
import { GEMINI_FAST, GEMINI_MEDIUM } from "~/lib/models";
import { createTypedStepClient } from "~/workflows/step-utils";
import {
  identifyLookaheadFacesOrFatal,
  loadLookaheadPageOrFatal,
  type LookaheadDeps,
  type LookaheadPage,
} from "~/workflows/steps/vision";
import {
  type Arm,
  type Attempt,
  DEFAULT_OUT,
  type RunFile,
  type ScoredRow,
  benchCli,
  countingClient,
  geminiFromEnv,
  geminiRate,
  geminiTokens,
  geminiUsd,
  median,
  newGate,
  pickArms,
  pool,
  refused,
  requireLiveApiOk,
  tierOf,
  writeRunFile,
} from "./bench-kit";

const BENCH = "face-id";
/** The `step` on llm meta; no row is written under DRY_RUN. */
const STEP = "bench-face-id";
const ARMS: Arm[] = [
  {
    name: "A",
    label: "GEMINI_MEDIUM, no thinking level (before #441)",
    model: GEMINI_MEDIUM,
  },
  {
    name: "B",
    label: "GEMINI_MEDIUM, thinkingLevel LOW",
    model: GEMINI_MEDIUM,
    thinkingLevel: ThinkingLevel.LOW,
  },
  {
    name: "C",
    label: "GEMINI_FAST, no thinking level",
    model: GEMINI_FAST,
  },
  {
    name: "D",
    label: "GEMINI_FAST, thinkingLevel MEDIUM (#450)",
    model: GEMINI_FAST,
    // The SDK's enum has no MEDIUM, so its wire value goes as the string.
    thinkingLevel: "MEDIUM" as ThinkingLevel,
  },
];
/**
 * Face ID's `llm_calls` rows on run wrun_01M458NQZ6TG3XPD7SGATD2V4J (#436's
 * smoke run 1). `llm_calls` has no run id, so the run is its book, step and
 * time window.
 */
const MEASURED = {
  runId: "wrun_01M458NQZ6TG3XPD7SGATD2V4J",
  bookId: "smoke-test",
  step: "character-lookahead",
  from: "2026-10-05T05:31:00Z",
  to: "2026-10-05T05:36:00Z",
};
/** Consecutive failed detections that end the whole invocation. */
const MAX_ERRORS_IN_A_ROW = 3;

// ── Args ────────────────────────────────────────────────────────────────
const { opt, flag, die, intOpt, parsePages, must } = benchCli("bench-face-id");
const dryRun = flag("--dry-run");
/**
 * Leave out a detection whose crop is gone. A detection's box is local to
 * its panel, so editing the panel's box in the review editor moves the crop
 * the bench cuts and the stored row no longer matches one (#450: page 10).
 */
const skipUnmatched = flag("--skip-unmatched");
const unmatched: string[] = [];
const armArg = opt("--arm") ?? "all";
const arms = pickArms(ARMS, armArg === "all" ? "A,B,C" : armArg, die);
const runs = intOpt("--runs", 3)!;
const gate = newGate(intOpt("--max-calls", 40)!);
const maxUsdRaw = opt("--max-usd");
const maxUsd = maxUsdRaw === undefined ? undefined : Number(maxUsdRaw);
if (maxUsd !== undefined && !(maxUsd > 0)) die("--max-usd wants a USD amount");
const concurrency = intOpt("--concurrency", 1)!;
const book = opt("--book") ?? "tmnt-mmpr-iii";
const issue = opt("--issue") ?? "issue-1";
const pages = parsePages(opt("--pages") ?? "3-13");
const outDir = opt("--out") ?? DEFAULT_OUT;

let primary: GoogleGenAI | null = null;
let fallback: GoogleGenAI | null = null;
if (!dryRun) {
  for (const a of arms) requireLiveApiOk("gemini", a.model, die);
  primary = geminiFromEnv(die);
  // The step fails over to the second key on a 429; so does the bench.
  const key2 = process.env.GEMINI_API_KEY_2;
  fallback = key2
    ? new (primary.constructor as typeof GoogleGenAI)({ apiKey: key2 })
    : null;
}

const supabase = await createTypedStepClient();
const deps: LookaheadDeps = {
  imageLib: sharp,
  faceExtraction,
  characterIdentification,
  exemplarStore,
  llmUsage,
  geminiClient: geminiClientLib,
};

// ── Detections and their crops ──────────────────────────────────────────
type Detection = {
  id: string;
  page: number;
  panelId: string;
  /** The reviewed `character_id`; null when the row is not human-verified. */
  truth: string | null;
  crop: FaceCropResult;
  lookahead: LookaheadPage;
};

const sameBox = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) =>
  Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.w - b.w),
    Math.abs(a.h - b.h),
  ) < 1e-9;

/** Every page's detections, each matched to the production crop it came from. */
async function loadDetections() {
  const detections: Detection[] = [];
  const perPage: string[] = [];
  let cropsUnused = 0;
  for (const page of pages) {
    const panels = must(
      await supabase
        .from("panels")
        .select("id")
        .eq("book_id", book)
        .eq("issue_id", issue)
        .eq("page_number", page),
      `panels read, page ${page}`,
    );
    const rows =
      panels.length === 0
        ? []
        : must(
            await supabase
              .from("panel_character_detections")
              .select("id, panel_id, face_bbox, character_id, human_verified")
              .in(
                "panel_id",
                panels.map((p) => p.id),
              )
              .order("id"),
            `panel_character_detections read, page ${page}`,
          );
    const lp = await loadLookaheadPageOrFatal(
      deps,
      supabase,
      book,
      issue,
      page,
      { skipIfStored: false },
    );
    if ("skip" in lp) {
      if (rows.length > 0) {
        die(
          `page ${page}: ${rows.length} detections but no crops (${lp.skip})`,
        );
      }
      perPage.push(`p${page}: 0 detections (${lp.skip})`);
      continue;
    }
    const used = new Set<number>();
    const pageDets: Detection[] = [];
    for (const r of rows) {
      const box = r.face_bbox as { x: number; y: number; w: number; h: number };
      const hits = lp.crops
        .map((c, i) => ({ c, i }))
        .filter(
          ({ c }) => c.panelId === r.panel_id && sameBox(c.bboxPanelLocal, box),
        );
      if (hits.length === 0 && skipUnmatched) {
        unmatched.push(`p${page} ${r.id}`);
        continue;
      }
      if (hits.length !== 1) {
        die(
          `page ${page}: detection ${r.id} matches ${hits.length} crops (want 1). A panel box edited since the detection was stored moves its crops; --skip-unmatched leaves such detections out.`,
        );
      }
      const { c, i } = hits[0]!;
      if (used.has(i)) die(`page ${page}: crop ${i} matches two detections`);
      used.add(i);
      pageDets.push({
        id: r.id,
        page,
        panelId: r.panel_id,
        truth: r.human_verified ? r.character_id : null,
        crop: c,
        lookahead: lp,
      });
    }
    // The step's order: crop order on the page.
    pageDets.sort(
      (a, b) => lp.crops.indexOf(a.crop) - lp.crops.indexOf(b.crop),
    );
    detections.push(...pageDets);
    cropsUnused += lp.crops.length - used.size;
    perPage.push(
      `p${page}: ${pageDets.length} detections, ${lp.crops.length} crops (${lp.crops.length - used.size} with no detection, not sent)`,
    );
  }
  if (unmatched.length > 0) {
    perPage.push(
      `Left out, no matching crop (--skip-unmatched): ${unmatched.join(", ")}`,
    );
  }
  return { detections, perPage, cropsUnused };
}

// ── One detection ───────────────────────────────────────────────────────
type Verdict =
  | "right"
  | "wrong"
  | "unnamed"
  | "dropped"
  | "error"
  /** Named, but the detection has no reviewed identity to score against. */
  | "unscored";

type FaceRow = ScoredRow & {
  arm: string;
  run: number;
  detectionId: string;
  page: number;
  panelId: string;
  truth: string | null;
  verdict: Verdict;
  /** The last response's text; null when its `.text` getter threw. */
  reply: string | null;
  /** The reply holds a JSON object `JSON.parse` accepts. */
  parsed: boolean;
  characterName: string | null;
  confidence: number | null;
  isFace: boolean | null;
  outcome: string | null;
  /** The character the step would store (`resolveCharacterId`). */
  characterId: string | null;
  /** Named, but no `characters` row matches: the step stores a suggested name. */
  namedOutsideCast: boolean;
  /** What went over the wire, as evidence the arm's config was sent. */
  requestModel: string | null;
  requestThinkingLevel: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensThinking: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  attempts: number;
  error: string | null;
};

function parses(text: string | null) {
  const m = text ? /\{[\s\S]*\}/.exec(text) : null;
  if (!m) return false;
  try {
    JSON.parse(m[0]);
    return true;
  } catch {
    return false;
  }
}

async function identifyOne(
  arm: Arm,
  run: number,
  d: Detection,
): Promise<FaceRow | null> {
  const log: Attempt[] = [];
  const { identifyFace } = characterIdentification;
  const armDeps: LookaheadDeps = {
    ...deps,
    characterIdentification: {
      ...characterIdentification,
      identifyFace: (...args: Parameters<typeof identifyFace>) => {
        const [g, face, mime, known, ex, page, pageMime, ctx, options] = args;
        return identifyFace(g, face, mime, known, ex, page, pageMime, ctx, {
          ...options,
          model: arm.model,
          // null, not undefined: unset would take production's LOW.
          thinkingLevel: arm.thinkingLevel ?? null,
        });
      },
    },
    // No exemplars (see the header): no embedding call, no lookup.
    exemplarStore: {
      ...exemplarStore,
      embedFace: () => Promise.resolve([]),
      findSimilarExemplars: () => Promise.resolve([]),
    },
    geminiClient: {
      ...geminiClientLib,
      getGeminiClient: () => countingClient(primary!, log, gate),
      getFallbackGeminiClient: () =>
        fallback ? countingClient(fallback, log, gate) : null,
    },
  };

  let face:
    | Awaited<ReturnType<typeof identifyLookaheadFacesOrFatal>>[number]
    | undefined;
  let error: string | null = null;
  try {
    [face] = await identifyLookaheadFacesOrFatal(
      armDeps,
      supabase,
      book,
      issue,
      { ...d.lookahead, crops: [d.crop] },
      STEP,
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // A detection that never reached the API (the ceiling) is left out.
  if (log.length === 0) return null;

  // The last response, even one whose `.text` threw (its reply is null;
  // identifyFace reads that as no match, so the face is dropped).
  const ok = [...log].reverse().find((a) => a.status === 200);
  const last = log[log.length - 1]!;
  const cost = log.reduce((s, a) => s + (a.costUsd ?? 0), 0);
  const tokens = ok ? geminiTokens(ok.usage) : null;
  const r = face?.result;
  const verdict: Verdict =
    !face || error
      ? "error"
      : face.outcome === "named"
        ? d.truth === null
          ? "unscored"
          : face.characterId === d.truth
            ? "right"
            : "wrong"
        : face.outcome === "unnamed"
          ? "unnamed"
          : "dropped";
  if (error && refused(last)) {
    // A request the API refuses (a bad model or config): stop everything.
    gate.halted ??= `HTTP ${last.status}: ${last.error}`;
  }
  return {
    id: d.id,
    label: `p${d.page} ${d.id.slice(0, 8)} (${d.truth ?? "no truth"})`,
    right: d.truth === null || verdict === "error" ? null : verdict === "right",
    arm: arm.name,
    run,
    detectionId: d.id,
    page: d.page,
    panelId: d.panelId,
    truth: d.truth,
    verdict,
    reply: ok?.reply ?? null,
    parsed: parses(ok?.reply ?? null),
    characterName: r?.characterName ?? null,
    confidence: r?.confidence ?? null,
    isFace: r?.isFace ?? null,
    outcome: face?.outcome ?? null,
    characterId: face?.characterId ?? null,
    namedOutsideCast: face?.outcome === "named" && face.characterId === null,
    requestModel: last.model,
    requestThinkingLevel: last.thinkingLevel,
    tokensIn: tokens?.input ?? null,
    tokensOut: tokens?.output ?? null,
    tokensThinking: tokens?.thinking ?? null,
    costUsd: cost,
    latencyMs: ok?.latencyMs ?? null,
    attempts: log.length,
    error: error ?? ok?.error ?? null,
  };
}

// ── Output ──────────────────────────────────────────────────────────────
const usd = (n: number) => `$${n.toFixed(4)}`;
const per = (total: number, n: number) => (n ? Math.round(total / n) : 0);

function summary(arm: Arm, run: number, rows: FaceRow[]): string {
  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  const ok = rows.filter((r) => r.tokensIn !== null);
  const sum = (pick: (r: FaceRow) => number | null) =>
    ok.reduce((s, r) => s + (pick(r) ?? 0), 0);
  const cost = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const scored = rows.filter((r) => r.right !== null).length;
  const noTruth = rows.filter((r) => r.truth === null).length;
  return [
    `Arm ${arm.name} run ${run}/${runs} (${tierOf(arm.model) ?? arm.model} ${arm.model}, thinking ${arm.thinkingLevel ?? "default"}):`,
    `right ${count("right")}/${scored},`,
    `wrong ${count("wrong")} (${rows.filter((r) => r.namedOutsideCast).length} named outside the cast),`,
    `unnamed ${count("unnamed") + count("dropped")} (${count("dropped")} of them dropped as no face),`,
    `errors ${count("error")}, unparsed ${rows.filter((r) => !r.parsed && r.verdict !== "error").length}${noTruth ? `, no truth ${noTruth}` : ""};`,
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
    `median latency ${median(rows.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs]))) ?? "n/a"} ms;`,
    `${rows.reduce((s, r) => s + r.attempts, 0)} requests for ${rows.length} detections.`,
  ].join(" ");
}

type Tokens = { input: number; output: number; thinking: number };

const callUsd = (model: string, t: Tokens) =>
  geminiUsd(
    {
      promptTokenCount: t.input,
      candidatesTokenCount: t.output,
      thoughtsTokenCount: t.thinking,
    },
    geminiRate(model),
  ) ?? Number.NaN;

/** One call's USD on an arm, low and high, from arm A's measured tokens. */
function armCallUsd(a: Arm, m: Tokens): [number, number] {
  if (a.model !== GEMINI_MEDIUM && !a.thinkingLevel) {
    const c = callUsd(a.model, { ...m, thinking: 0 });
    return [c, c];
  }
  const ceil = callUsd(a.model, m);
  return [
    a.thinkingLevel ? callUsd(a.model, { ...m, thinking: 0 }) : ceil,
    ceil,
  ];
}

/** The measured face ID `llm_calls` rows and their mean tokens a call. */
async function readMeasured() {
  const rows = must(
    await supabase
      .from("llm_calls")
      .select(
        "model, tokens_in, tokens_out, tokens_thinking, usd_est, duration_ms",
      )
      .eq("provider", "gemini")
      .eq("book_id", MEASURED.bookId)
      .eq("step", MEASURED.step)
      .eq("ok", true)
      // The step's embedding rows share its name and carry no token counts.
      .not("tokens_in", "is", null)
      .gte("created_at", MEASURED.from)
      .lt("created_at", MEASURED.to),
    "llm_calls read",
  );
  const mean = (pick: (r: (typeof rows)[number]) => number | null) =>
    rows.reduce((s, r) => s + (pick(r) ?? 0), 0) / rows.length;
  const m: Tokens = {
    input: mean((r) => r.tokens_in),
    output: mean((r) => r.tokens_out),
    thinking: mean((r) => r.tokens_thinking),
  };
  return { rows, mean, m };
}

/** `--dry-run`: the estimate from the measured face ID rows. */
async function dryRunReport(
  detections: Detection[],
  perPage: string[],
  cropsUnused: number,
) {
  const n = detections.length;
  const calls = n * runs;
  const withTruth = detections.filter((d) => d.truth !== null).length;
  const truthCounts = new Map<string, number>();
  for (const d of detections) {
    const k = d.truth ?? "(no truth)";
    truthCounts.set(k, (truthCounts.get(k) ?? 0) + 1);
  }
  const { rows, mean, m } = await readMeasured();
  const out: string[] = [
    `DRY RUN, no Gemini call. ${book} / ${issue}, pages ${pages.join(", ")}.`,
    ...perPage.map((l) => `  ${l}`),
    `Detections: ${n}, ${withTruth} with a reviewed identity (human_verified character_id), ${n - withTruth} with none. Crops with no detection, not sent: ${cropsUnused}.`,
    `Truth: ${[...truthCounts]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
    `Production makes one identifyFace call per crop (lookahead's loop; a second only on a 429, on the fallback key). matchFaceToClusters has no caller.`,
    `Calls: ${n} per arm and run, ${calls} per arm for ${runs} run(s), ${calls * arms.length} for arms ${arms.map((a) => a.name).join(", ")}. That needs --max-calls ${calls * arms.length} or more (plus retries).`,
    "",
  ];
  if (rows.length === 0) {
    out.push(
      `No llm_calls rows found for ${MEASURED.runId} (${MEASURED.bookId}, ${MEASURED.step}, ${MEASURED.from} to ${MEASURED.to}): no estimate.`,
    );
    console.log(`\n${out.join("\n")}`);
    return;
  }
  const models = [...new Set(rows.map((r) => r.model))].join(", ");
  const usdSum = rows.reduce((s, r) => s + Number(r.usd_est ?? 0), 0);
  out.push(
    `Measured: run ${MEASURED.runId}, ${rows.length} face ID llm_calls rows on ${models}: ${Math.round(m.input)} in, ${Math.round(m.output)} out, ${Math.round(m.thinking)} thinking tokens a call (mean), usd_est $${usdSum.toFixed(5)} in all, ${Math.round(mean((r) => r.duration_ms))} ms a call (mean).`,
    "Those inputs include exemplar images on smoke page 2; the bench sends none, so its input tokens run a little lower.",
    "",
    `Estimate, ${calls} calls per arm:`,
  );
  let lo = 0;
  let hi = 0;
  for (const a of arms) {
    const tier = `${tierOf(a.model) ?? a.model} ${a.model}`;
    const [floor, ceil] = armCallUsd(a, m);
    lo += floor * calls;
    hi += ceil * calls;
    if (a.model === GEMINI_MEDIUM && !a.thinkingLevel) {
      out.push(
        `  ${a.name} (${tier}, default thinking): $${(floor * calls).toFixed(2)} at $${floor.toFixed(5)} a call. Measured tokens, priced at ${tier}'s rate.`,
      );
    } else if (a.thinkingLevel) {
      out.push(
        `  ${a.name} (${tier}, thinking ${a.thinkingLevel}): $${(floor * calls).toFixed(2)} to $${(ceil * calls).toFixed(2)}. Input and output measured; thinking is a guess, from 0 up to arm A's measured ${Math.round(m.thinking)} a call.`,
      );
    } else {
      out.push(
        `  ${a.name} (${tier}, default thinking): $${(floor * calls).toFixed(2)} at $${floor.toFixed(5)} a call. A guess: no face ID call has run on ${a.model}; arm A's measured input and output tokens, 0 thinking (its default, minimal, thought 0 tokens on the speaker call in #431), at ${tier}'s rate.`,
      );
    }
  }
  out.push(`  Total: $${lo.toFixed(2)} to $${hi.toFixed(2)}.`);
  console.log(`\n${out.join("\n")}`);
}

// ── Main ────────────────────────────────────────────────────────────────
const { detections, perPage, cropsUnused } = await loadDetections();
if (detections.length === 0)
  die(`${book}/${issue}: no detections on pages ${pages.join(", ")}`);
if (dryRun) {
  await dryRunReport(detections, perPage, cropsUnused);
  process.exit(0);
}
if (unmatched.length > 0) {
  console.log(
    `Left out, no matching crop (--skip-unmatched), ${unmatched.length}: ${unmatched.join(", ")}`,
  );
}

if (maxUsd !== undefined) {
  // Each request reserves the high estimate of the dearest arm in the run.
  const { rows, m } = await readMeasured();
  if (rows.length === 0) {
    die(
      `--max-usd needs the face ID llm_calls rows of ${MEASURED.runId} for its per-call reservation; none found`,
    );
  }
  gate.usd = {
    max: maxUsd,
    seed: Math.max(...arms.map((a) => armCallUsd(a, m)[1])),
  };
}

// Under DRY_RUN the Gemini wrapper writes no llm_calls row (see the header).
process.env.DRY_RUN = "1";
console.log(
  `${detections.length} detections; arms ${arms.map((a) => a.name).join(", ")}; ${runs} run(s); --max-calls ${gate.budget.max}${gate.usd ? `; --max-usd ${gate.usd.max} (reserving $${gate.usd.seed.toFixed(5)} a call)` : ""}; concurrency ${concurrency}`,
);
const written: string[] = [];
const summaries: string[] = [];
for (let run = 1; run <= runs && !gate.halted; run++) {
  for (const arm of arms) {
    if (gate.halted) break;
    const startedAt = new Date().toISOString();
    let errorsInARow = 0;
    const rows = (
      await pool(
        detections,
        concurrency,
        async (d, i) => {
          const row = await identifyOne(arm, run, d);
          if (row) {
            errorsInARow = row.verdict === "error" ? errorsInARow + 1 : 0;
            if (errorsInARow >= MAX_ERRORS_IN_A_ROW) {
              gate.halted ??= `${MAX_ERRORS_IN_A_ROW} failed detections in a row (last: ${row.error})`;
            }
            console.log(
              `[${arm.name}${run} ${i + 1}/${detections.length}] p${d.page} ${d.id.slice(0, 8)} truth ${d.truth} → ${row.verdict}${row.characterId ? ` ${row.characterId}` : row.characterName ? ` "${row.characterName}"` : ""} (${row.latencyMs ?? "-"} ms, ${row.tokensThinking ?? "-"} thinking)${row.error ? ` error: ${row.error}` : ""}`,
            );
          }
          return row;
        },
        () => gate.halted !== null,
      )
    ).filter((r): r is FaceRow => r != null);
    const file: RunFile<FaceRow> = {
      bench: BENCH,
      arm: arm.name,
      armLabel: arm.label,
      model: arm.model,
      thinkingLevel: arm.thinkingLevel ?? null,
      run,
      runs,
      complete: rows.length === detections.length,
      stop: gate.halted,
      book,
      issue,
      pages,
      startedAt,
      finishedAt: new Date().toISOString(),
      rows,
      ...(unmatched.length > 0 ? { leftOut: unmatched } : {}),
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
    `Requests ${gate.budget.calls}, spent $${gate.spentUsd.toFixed(4)}.${gate.halted ? ` Stopped early: ${gate.halted}` : ""}`,
  ].join("\n"),
);
