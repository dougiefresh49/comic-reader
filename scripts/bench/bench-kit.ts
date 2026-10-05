/**
 * What the benches under scripts/bench/ share (#441, decisions row 293): the
 * CLI helpers, `--model` tier names, Gemini cost from
 * `GEMINI_USD_PER_1M_TOKENS`, the `--max-calls` and `--max-usd` gate, the `LIVE_API_OK=1`
 * guard and the run-file directory. Plus what a repeated-run bench needs:
 * arms, run files, and the cross-run comparison (`compare-runs.ts` is its
 * CLI), which is #431's `compare.py` method.
 *
 * A run file is one JSON object, `RunFile`, holding one arm's one run. The
 * speaker bench predates it and still writes a bare row array, which the
 * comparison skips.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type GenerateContentParameters,
  type GenerateContentResponse,
  GoogleGenAI,
  type ThinkingLevel,
} from "@google/genai";
import {
  GEMINI_FAST,
  GEMINI_HIGH,
  GEMINI_MEDIUM,
  GEMINI_USD_PER_1M_TOKENS,
} from "~/lib/models";

// ── CLI ─────────────────────────────────────────────────────────────────
export type Die = (msg: string) => never;

/** Argument helpers for one bench; every error is prefixed with `tool`. */
export function benchCli(tool: string, argv = process.argv.slice(2)) {
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const flag = (name: string) => argv.includes(name);
  const die: Die = (msg) => {
    console.error(`${tool}: ${msg}`);
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
    if (!Number.isFinite(n) || n < 0)
      die(`${name} wants a price in USD per 1M`);
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
  /** A Supabase result's data, or die naming `what`. */
  function must<T>(
    res: { data: T | null; error: { message: string } | null },
    what: string,
  ): T {
    if (res.error) die(`${what}: ${res.error.message}`);
    return res.data as T;
  }
  return { opt, flag, die, intOpt, priceOpt, oneOf, parsePages, must };
}

// ── Models, cost, spend guard ───────────────────────────────────────────
/** Where run files go without `--out`: outside /tmp, which lost bench files once (#431). */
export const DEFAULT_OUT = join(homedir(), "comic-reader-bench");

/** `--model` may name a tier; the id comes from `src/lib/models.ts`. */
export const TIERS: Record<string, string> = {
  GEMINI_HIGH,
  GEMINI_MEDIUM,
  GEMINI_FAST,
};

/** A tier name to its model id; anything else is taken as an id. */
export const resolveModel = (arg: string) => TIERS[arg] ?? arg;

/** The tier name a model id is, if any. */
export const tierOf = (model: string) =>
  Object.keys(TIERS).find((t) => TIERS[t] === model);

export type Rate = { input: number; output: number };

/** USD per 1M tokens for a Gemini model id, from `src/lib/models.ts`. */
export const geminiRate = (model: string): Rate | undefined =>
  GEMINI_USD_PER_1M_TOKENS[model];

/** Gemini `usageMetadata` as tokens; `output` excludes thinking. */
export function geminiTokens(usage: unknown) {
  const u = (usage ?? {}) as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  return {
    input: u.promptTokenCount ?? 0,
    output: u.candidatesTokenCount ?? 0,
    thinking: u.thoughtsTokenCount ?? 0,
  };
}

/** USD for one Gemini reply; thinking bills as output, as `llm_calls` counts it. */
export function geminiUsd(usage: unknown, rate: Rate | undefined) {
  if (!usage || !rate) return null;
  const t = geminiTokens(usage);
  return (t.input * rate.input + (t.output + t.thinking) * rate.output) / 1e6;
}

/**
 * The spend guard: on OpenRouter only `:free` ids, on the Gemini API only
 * `gemma-` ids run without LIVE_API_OK=1 (a spend the owner named).
 */
export function requireLiveApiOk(
  provider: "openrouter" | "gemini",
  model: string,
  die: Die,
) {
  if (process.env.LIVE_API_OK === "1") return;
  if (provider === "openrouter" && !model.endsWith(":free")) {
    die(
      `refusing model "${model}" on OpenRouter: only ":free" ids run without LIVE_API_OK=1 (a spend the owner named)`,
    );
  }
  if (provider === "gemini" && !model.startsWith("gemma-")) {
    die(
      `refusing model "${model}" on the Gemini API: only "gemma-" ids run without LIVE_API_OK=1 (a spend the owner named)`,
    );
  }
}

/** A Gemini client on `GEMINI_API_KEY` from .env, or die. */
export function geminiFromEnv(die: Die): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) die("GEMINI_API_KEY is not set in .env");
  return new GoogleGenAI({ apiKey });
}

/**
 * `--max-calls`: every request takes one call, retries included. Check and
 * count happen with no await between them, so the ceiling holds across
 * concurrent workers.
 */
export class CallBudget {
  calls = 0;
  constructor(readonly max: number) {}
  take(): boolean {
    if (this.calls >= this.max) return false;
    this.calls++;
    return true;
  }
}

/** One request a bench sent, as evidence of what went over the wire. */
export type Attempt = {
  model: string;
  thinkingLevel: string | null;
  latencyMs: number;
  usage: unknown;
  /** Null when the request failed, or when the response's `.text` threw. */
  reply: string | null;
  status: number | null;
  /** The request's error, or the `.text` getter's on a 200. */
  error: string | null;
  /** From `usage` at the request model's rate; null with no usage or rate. */
  costUsd: number | null;
};

/**
 * One invocation's stop state and spend: `halted` is set once (`--max-usd`,
 * a refused request, `--max-calls`) and from then on no request is sent,
 * retries included. `spentUsd` is every completed request's cost, counted
 * here and nowhere else.
 *
 * `usd` is `--max-usd`. A request goes out only if `spentUsd` plus one
 * reservation for each request in flight and one for itself stays within
 * `max`. A reservation is the larger of `seed` (the bench's per-call figure
 * for its dearest arm) and the costliest completed request so far. The limit
 * can still be passed by at most the amount one call exceeds its
 * reservation, per request in flight.
 */
export type Gate = {
  budget: CallBudget;
  halted: string | null;
  usd?: { max: number; seed: number };
  spentUsd: number;
  dearestUsd: number;
  inFlight: number;
};

/** A gate on `--max-calls`; a bench sets `usd` when `--max-usd` is given. */
export const newGate = (maxCalls: number): Gate => ({
  budget: new CallBudget(maxCalls),
  halted: null,
  spentUsd: 0,
  dearestUsd: 0,
  inFlight: 0,
});

/**
 * A client whose `models.generateContent` checks the gate (`--max-usd`,
 * then `--max-calls`) before sending, counts the request's cost, and logs it
 * to `log`. A 200 is returned and logged as one whatever its `.text` getter
 * does, so the caller's own handling of the getter runs as in production.
 */
export function countingClient(
  real: GoogleGenAI,
  log: Attempt[],
  gate: Gate,
): GoogleGenAI {
  const generateContent = async (params: GenerateContentParameters) => {
    const thinkingLevel =
      (params.config?.thinkingConfig?.thinkingLevel as string | undefined) ??
      null;
    // A halt (--max-usd, a refused request) also stops requests already
    // queued behind it, the 429 retry on the fallback key included.
    if (gate.halted) throw new Error(gate.halted);
    // Check and reserve with no await between, so concurrent workers see
    // each other's reservations.
    if (gate.usd) {
      const each = Math.max(gate.usd.seed, gate.dearestUsd);
      if (!(gate.spentUsd + (gate.inFlight + 1) * each <= gate.usd.max)) {
        gate.halted ??= `--max-usd ${gate.usd.max} reached ($${gate.spentUsd.toFixed(4)} spent, ${gate.inFlight} in flight at $${each.toFixed(5)} each)`;
        throw new Error(gate.halted);
      }
    }
    if (!gate.budget.take()) {
      gate.halted ??= `--max-calls ${gate.budget.max} reached`;
      throw new Error(`--max-calls ${gate.budget.max} reached`);
    }
    gate.inFlight++;
    const started = Date.now();
    const attempt = { model: params.model, thinkingLevel };
    let res: GenerateContentResponse;
    try {
      res = await real.models.generateContent(params);
    } catch (e) {
      gate.inFlight--;
      log.push({
        ...attempt,
        latencyMs: Date.now() - started,
        usage: null,
        reply: null,
        status: (e as { status?: number } | null)?.status ?? 0,
        error: e instanceof Error ? e.message : String(e),
        costUsd: null,
      });
      throw e;
    }
    const latencyMs = Date.now() - started;
    const usage = res.usageMetadata ?? null;
    const costUsd = geminiUsd(usage, geminiRate(params.model));
    gate.inFlight--;
    gate.spentUsd += costUsd ?? 0;
    gate.dearestUsd = Math.max(gate.dearestUsd, costUsd ?? 0);
    // `.text` is an SDK getter that can throw (a null content part); the
    // tokens were billed all the same.
    let reply: string | null = null;
    let error: string | null = null;
    try {
      reply = res.text ?? "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    log.push({
      ...attempt,
      latencyMs,
      usage,
      reply,
      status: 200,
      error,
      costUsd,
    });
    return res;
  };
  return { models: { generateContent } } as unknown as GoogleGenAI;
}

/** A request the API refused (a bad model or config): 4xx other than 429. */
export const refused = (a: Attempt | undefined) =>
  !!a &&
  a.status !== null &&
  a.status >= 400 &&
  a.status < 500 &&
  a.status !== 429;

/** The median, the two middle values' mean rounded when the count is even. */
export function median(values: number[]): number | null {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2);
}

/** Run `fn` over `items`, at most `n` at once; results keep `items` order. */
export async function pool<T, R>(
  items: T[],
  n: number,
  fn: (item: T, index: number) => Promise<R>,
  stop: () => boolean = () => false,
): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length && !stop()) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

// ── Arms and run files ──────────────────────────────────────────────────
/** One configuration under test. */
export type Arm = {
  name: string;
  label: string;
  model: string;
  /** Unset sends no thinkingConfig, the model's default. */
  thinkingLevel?: ThinkingLevel;
};

/** `--arm A|B|all` against a bench's arms. */
export function pickArms(arms: Arm[], pick: string, die: Die): Arm[] {
  if (pick === "all") return arms;
  const names = pick.split(",");
  const out = arms.filter((a) => names.includes(a.name));
  if (out.length !== names.length) {
    die(
      `--arm takes ${arms.map((a) => a.name).join(", ")} or all, got "${pick}"`,
    );
  }
  return out;
}

/** What the comparison needs from a row; `right: null` is not scored. */
export type ScoredRow = {
  id: string;
  label: string;
  right: boolean | null;
  costUsd?: number | null;
};

export type RunFile<R extends ScoredRow = ScoredRow> = {
  bench: string;
  arm: string;
  armLabel: string;
  model: string;
  thinkingLevel: string | null;
  run: number;
  runs: number;
  /** False when the run stopped before every item was sent. */
  complete: boolean;
  stop: string | null;
  book: string;
  issue: string;
  pages: number[];
  startedAt: string;
  finishedAt: string;
  rows: R[];
  /** Set by `readRunFiles`, never written. */
  path?: string;
};

export function writeRunFile<R extends ScoredRow>(
  outDir: string,
  file: RunFile<R>,
): string {
  mkdirSync(outDir, { recursive: true });
  const stamp = file.startedAt.replace(/[:.]/g, "-");
  const path = join(
    outDir,
    `${file.bench}-${file.arm}-run${file.run}${file.complete ? "" : "-partial"}-${stamp}.json`,
  );
  writeFileSync(path, JSON.stringify(file, null, 2));
  return path;
}

/** Every `RunFile` of `bench` in `dir`; other JSON (speaker rows) is skipped. */
export function readRunFiles(dir: string, bench: string): RunFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        const data = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
        const rf = data as Partial<RunFile>;
        return rf && rf.bench === bench && Array.isArray(rf.rows)
          ? [{ ...(rf as RunFile), path: join(dir, f) }]
          : [];
      } catch {
        return [];
      }
    });
}

// ── Cross-run comparison ────────────────────────────────────────────────
/**
 * Two-sided sign test: of `a + b` discordant items, `a` favour one side and
 * `b` the other; the chance of a split this lopsided if both were equal.
 */
export function signTest(a: number, b: number): number {
  const n = a + b;
  if (n === 0) return 1;
  const k = Math.min(a, b);
  let term = 2 ** -n; // C(n, 0) / 2^n
  let tail = term;
  for (let i = 1; i <= k; i++) {
    term = (term * (n - i + 1)) / i;
    tail += term;
  }
  return Math.min(1, 2 * tail);
}

const score = (rows: ScoredRow[]) => {
  const scored = rows.filter((r) => r.right !== null);
  return { right: scored.filter((r) => r.right).length, of: scored.length };
};

/**
 * #431's method over run files: each arm's score per run and its spread,
 * the items that flip between runs of one arm, and between two arms the
 * items every run of one gets right and every run of the other gets wrong,
 * with a sign test on those.
 */
export function compareRuns(files: RunFile[]): string[] {
  // Runs of different page sets or configs share no items to compare; mixed
  // in, they would hide a real difference behind "absent".
  const scope = (f: RunFile) =>
    `${f.book}/${f.issue} pages ${f.pages.join(",")}`;
  const config = (f: RunFile) =>
    `${f.model}, thinking ${f.thinkingLevel ?? "default"}`;
  for (const f of files) {
    const first = files[0]!;
    if (scope(f) !== scope(first)) {
      throw new Error(
        `run files cover different items: ${scope(first)} (${first.path ?? first.startedAt}) and ${scope(f)} (${f.path ?? f.startedAt}). Narrow with --since or --files.`,
      );
    }
    const sameArm = files.find((g) => g.arm === f.arm)!;
    if (config(f) !== config(sameArm)) {
      throw new Error(
        `arm ${f.arm} has runs on different configs: ${config(sameArm)} and ${config(f)}. Narrow with --since or --files.`,
      );
    }
  }
  const byArm = new Map<string, RunFile[]>();
  for (const f of [...files].sort(
    (a, b) =>
      a.arm.localeCompare(b.arm) || a.startedAt.localeCompare(b.startedAt),
  )) {
    byArm.set(f.arm, [...(byArm.get(f.arm) ?? []), f]);
  }
  const out: string[] = [];
  const labels = new Map<string, string>();
  /** Per arm: item id → its verdict in each run (null: not scored or absent). */
  const verdicts = new Map<string, Map<string, (boolean | null)[]>>();

  for (const [arm, runs] of byArm) {
    const first = runs[0]!;
    out.push(
      `## Arm ${arm}: ${first.armLabel} (${first.model}, thinking ${first.thinkingLevel ?? "default"})`,
    );
    const counts: number[] = [];
    for (const [i, f] of runs.entries()) {
      const s = score(f.rows);
      counts.push(s.right);
      const cost = f.rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      out.push(
        `- run ${i + 1} (${f.startedAt}${f.complete ? "" : ", PARTIAL"}): ${s.right}/${s.of} right, cost $${cost.toFixed(4)}${f.path ? `, ${f.path}` : ""}`,
      );
    }
    out.push(
      `- spread over ${runs.length} run(s): min ${Math.min(...counts)}, max ${Math.max(...counts)}`,
    );

    const ids = new Map<string, (boolean | null)[]>();
    for (const [i, f] of runs.entries()) {
      for (const r of f.rows) {
        labels.set(r.id, r.label);
        const v =
          ids.get(r.id) ?? new Array<boolean | null>(runs.length).fill(null);
        v[i] = r.right;
        ids.set(r.id, v);
      }
    }
    verdicts.set(arm, ids);
    const flips = [...ids].filter(([, v]) => {
      const seen = v.filter((x) => x !== null);
      return seen.includes(true) && seen.includes(false);
    });
    out.push(`- flips between runs: ${flips.length}`);
    const mark = (x: boolean | null) => (x === null ? "-" : x ? "R" : "W");
    for (const [id, v] of flips) {
      out.push(`  - ${labels.get(id) ?? id}: ${v.map(mark).join(" ")}`);
    }
    out.push("");
  }

  const arms = [...byArm.keys()];
  /** Right in every run (true), wrong in every run (false), else null. */
  const always = (v: (boolean | null)[] | undefined) =>
    !v || v.some((x) => x === null)
      ? null
      : v.every((x) => x)
        ? true
        : v.every((x) => !x)
          ? false
          : null;
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const [x, y] = [arms[i]!, arms[j]!];
      const vx = verdicts.get(x)!;
      const vy = verdicts.get(y)!;
      const xOnly: string[] = [];
      const yOnly: string[] = [];
      for (const [id, v] of vx) {
        const ax = always(v);
        const ay = always(vy.get(id));
        if (ax === true && ay === false) xOnly.push(id);
        if (ax === false && ay === true) yOnly.push(id);
      }
      out.push(
        `## ${x} vs ${y}: ${xOnly.length} right in every ${x} run and wrong in every ${y} run, ${yOnly.length} the other way; sign test p = ${signTest(xOnly.length, yOnly.length).toFixed(4)}`,
        ...xOnly.map((id) => `- ${x} only: ${labels.get(id) ?? id}`),
        ...yOnly.map((id) => `- ${y} only: ${labels.get(id) ?? id}`),
        "",
      );
    }
  }
  return out;
}
