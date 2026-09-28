/**
 * Smoke-test the ingest workflow through every gate (#92). Seeds book
 * `smoke-test` / `issue-smoke` from two tmnt-mmpr-iii pages, runs the
 * pipeline on a fresh `pnpm dev` under DRY_RUN, resumes each gate, asserts
 * the rows the reader needs, then deletes everything it wrote.
 *
 * Writes only under book_id 'smoke-test' and the `smoke-test/` Storage prefix
 * (decision row 84), plus `characters` rows for the fixtures' `smoke-` ids
 * and any `character_appearances` rows the run writes for them (option B,
 * owner's answers on #92). Every other global table is read, never written.
 *
 * Usage:
 *   pnpm exec tsx --env-file=.env scripts/smoke-ingest.ts --scenario clean|gates [--keep]
 *   pnpm exec tsx --env-file=.env scripts/smoke-ingest.ts --cleanup-only
 *   ... --real --confirm-spend   (#97 only: no DRY_RUN, paid calls)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAUSE_TO_HOOK_STEP } from "~/app/api/admin/cancel-ingest/hooks";
import { loadIngestFixture } from "~/lib/fakes/dry-run";
import {
  deleteIssue,
  insertIssue,
  listAllIssues,
  listBookIssues,
  selectIssue,
} from "~/lib/issue-queries";
import { pageStoragePath } from "~/lib/storage";
import { slugify } from "~/workflows/steps/audio-plan";
import { supabase } from "./lib/supabase";

const BOOK = "smoke-test";
const ISSUE = "issue-smoke";
const SRC_BOOK = "tmnt-mmpr-iii";
const SRC_ISSUE = "issue-1";
const SRC_PAGES = [7, 8];
const PORT = 3082;
const BASE = `http://localhost:${PORT}`;
const BUCKETS = ["comic-pages", "comic-audio", "face-exemplars"];
const REQUIRED_KEYS = [
  "ROBOFLOW_API_KEY",
  "ROBOFLOW_WORKFLOW_URL",
  "GEMINI_API_KEY",
  "GEMINI_API_KEY_2",
  "ELEVENLABS_API_KEY",
  "VENICE_API_KEY",
];
/** Every table with a book_id column (src/types/database.ts), in FK-safe delete order. */
const BOOK_TABLES = [
  "audio_timestamps",
  "casting_tasks",
  "castlist",
  "speaker_reviews",
  "page_context",
  "pipeline_runs",
  "character_face_exemplars",
  "page_segmentation",
  "music_scenes",
  "bubbles",
  "panels",
  "pages",
  "issues",
  "book_parts",
];
const LOG_FAILURES = [
  /DRY_RUN: no context fixture/,
  /context analysis failed/,
  /DRY_RUN: no Gemini fixture/,
  /step will be retried/,
];
const GATE_TIMEOUT_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 20 * 60_000;
const RESUME_RETRY_MS = 60_000;
const SKIPPED_VOICE = "__SKIPPED__";

type Expect = { gate: string; expect: "pause" | "skip" };
type Scenario = {
  gates: Expect[];
  omitCastForLegacyId: string | null;
  counts: Record<string, number>;
  /** Bubbles the gates fake gives the uncast "Smoke Stranger". */
  strangerBubbles: number;
};
type Skip = { gate: string; reason: string };

class SmokeFailure extends Error {}
const fail = (msg: string): never => {
  throw new SmokeFailure(msg);
};
// ── Signals: the handler only flags and stops the server; main() cleans up ─
const INTERRUPTED = "interrupted by a signal";
const live: { child: ChildProcess | null } = { child: null };
let stopping = false;
/** Called between phases and in every wait loop; main's finally cleans up. */
const checkStop = () => {
  if (stopping) fail(INTERRUPTED);
};
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(
      stopping
        ? `\n${sig}: still cleaning up`
        : `\n${sig}: stopping; cleanup will run, further Ctrl-C is ignored`,
    );
    stopping = true;
    if (live.child) void stopDevServer(live.child);
  });
}
// Synchronous last resort, so no exit path leaves the dev server's group up.
process.on("exit", () => {
  const c = live.child;
  if (c?.pid && c.exitCode === null && c.signalCode === null) {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      /* group already gone */
    }
  }
});

/** Any error becomes a reported problem, so cleanup always runs. */
const errText = (err: unknown) =>
  err instanceof SmokeFailure
    ? err.message
    : `unexpected: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;

function must<T>(
  res: { data: T | null; error: { message: string } | null },
  what: string,
): T {
  if (res.error) fail(`${what}: ${res.error.message}`);
  return res.data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Eqs = Record<string, string>;
function withEqs<Q extends { eq(column: string, value: string): Q }>(
  q: Q,
  eqs: Eqs,
): Q {
  for (const [k, v] of Object.entries(eqs)) q = q.eq(k, v);
  return q;
}

type Page<T> = PromiseLike<{
  data: T[] | null;
  error: { message: string } | null;
}>;
/** Every row, 1000 at a time; `page` must order on a unique key. */
async function paged<T>(
  page: (from: number, to: number) => Page<T>,
  what: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await page(from, from + 999), what) ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

async function countOf(table: string, eqs: Eqs = {}): Promise<number> {
  const q = supabase.from(table).select("*", { count: "exact", head: true });
  const { count, error } = await withEqs(q, eqs);
  if (error) fail(`${table} count: ${error.message}`);
  return count ?? 0;
}

// ── Args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const scenarioName = argv[argv.indexOf("--scenario") + 1];
const real = flag("--real");
const confirmSpend = flag("--confirm-spend");

// ── Smoke character ids (option B, owner's answers on #92) ────────────
const normName = (s: string) =>
  s.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
const PREFIX = "smoke-";

/** Mirrors fuzzyNameMatch in src/workflows/steps/vision.ts (not exported). */
function fuzzy(a: string, b: string): boolean {
  const [na, nb] = [normName(a), normName(b)];
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const [wa, wb] = [na.split(" "), nb.split(" ")];
  return (
    wa.length >= 2 &&
    wb.length >= 2 &&
    wa[0] === wb[0] &&
    wa.at(-1) === wb.at(-1)
  );
}

/** Distinct non-narrator speaker and face ids in fixtures/ingest/pages.json. */
function fixtureIds(): string[] {
  const ids = new Set<string>();
  for (const p of loadIngestFixture().pages) {
    for (const b of p.bubbles) if (b.speaker) ids.add(b.speaker);
    for (const f of p.faces) ids.add(f.characterName);
  }
  return [...ids].filter((id) => normName(id) !== "narrator").sort();
}

/**
 * The only global rows setup and cleanup touch: exact fixture ids that carry
 * the prefix, plus `smoke-stranger` in case a step created one (gates).
 */
const smokeIds = () =>
  [...fixtureIds(), "smoke-stranger"].filter((id) => id.startsWith(PREFIX));
const inList = (ids: string[]) => `(${ids.join(",")})`;

/** Checked before any write. */
async function assertSmokeIds(): Promise<void> {
  const ids = fixtureIds();
  const unprefixed = ids.filter((id) => !id.startsWith(PREFIX));
  if (unprefixed.length > 0) {
    fail(
      `fixture ids without the "${PREFIX}" prefix (#196); refusing to start: ${unprefixed.join(", ")}`,
    );
  }
  const rows = await paged<{ id: string; aliases: string[] | null }>(
    (a, b) =>
      supabase.from("characters").select("id, aliases").order("id").range(a, b),
    "characters select",
  );
  const leftovers = rows.filter((c) => smokeIds().includes(c.id));
  if (leftovers.length > 0) {
    fail(
      `characters rows left by a crashed run: ${leftovers.map((c) => c.id).join(", ")}. Run --cleanup-only first.`,
    );
  }
  // A smoke name must not resolve to a production character either,
  // including the gates-only stranger names from src/lib/fakes/gemini.ts.
  const hits: string[] = [];
  for (const id of [...ids, "smoke-stranger", "Smoke Stranger"]) {
    for (const c of rows) {
      const match = [c.id, ...(c.aliases ?? [])].find((v) => fuzzy(id, v));
      if (match) hits.push(`${id} ~ characters.${c.id} (${match})`);
    }
  }
  if (hits.length > 0) {
    fail(
      `fixture ids match production characters; refusing to start:\n  ${hits.slice(0, 20).join("\n  ")}${hits.length > 20 ? `\n  ... ${hits.length - 20} more` : ""}`,
    );
  }
}

// ── Isolation snapshot ──────────────────────────────────────────────────
/** Per table: row key → hash of the whole row, for every non-smoke row. */
type Snapshot = Record<string, Map<string, string>>;
const rowHash = (r: unknown) =>
  createHash("sha256").update(JSON.stringify(r)).digest("hex");

async function snapshot(): Promise<Snapshot> {
  type Row = Record<string, unknown> & { id: string | number };
  const hashed = (rows: Row[], key: (r: Row) => string = (r) => `${r.id}`) =>
    new Map(rows.map((r) => [key(r), rowHash(r)]));
  // Global tables, minus the smoke ids (column), ordered on the primary key.
  const global = (table: string, column?: string, scopeGlobal = false) =>
    paged<Row>((a, b) => {
      let q = supabase.from(table).select("*");
      if (scopeGlobal) q = q.eq("scope", "global");
      if (column) q = q.not(column, "in", inList(smokeIds()));
      return q.order("id").range(a, b);
    }, table);
  const issues = await paged<Row>(
    (a, b) =>
      listAllIssues(supabase, "*")
        .neq("book_id", BOOK)
        .order("book_id")
        .order("id")
        .range(a, b) as unknown as Page<Row>,
    "issues",
  );
  return {
    "issues (other books)": hashed(
      issues,
      (r) => `${r.book_id as string}/${r.id}`,
    ),
    characters: hashed(await global("characters", "id")),
    character_appearances: hashed(
      await global("character_appearances", "character_id"),
    ),
    voices: hashed(await global("voices")),
    "global aliases": hashed(await global("aliases", undefined, true)),
  };
}

/** One line per table that differs, naming the added, removed or changed keys. */
function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const [table, was] of Object.entries(before)) {
    const now = after[table] ?? new Map<string, string>();
    const keys = new Set([...was.keys(), ...now.keys()]);
    const changed = [...keys].filter((k) => was.get(k) !== now.get(k));
    if (changed.length > 0) {
      out.push(
        `${table}: ${changed.length} rows differ (${changed.slice(0, 10).join(", ")}${changed.length > 10 ? ", ..." : ""})`,
      );
    }
  }
  return out;
}

/** `dry-run-` voice ids in shared rows; outside the smoke ids only, or anywhere. */
async function fakeVoiceRows(outsideSmoke: boolean): Promise<string[]> {
  let q = supabase
    .from("character_appearances")
    .select("id, character_id, voice_id")
    .like("voice_id", "dry-run-%");
  if (outsideSmoke) q = q.not("character_id", "in", inList(smokeIds()));
  const appearances = must(await q, "fake voice ids") as unknown[];
  const cast = must(
    await supabase
      .from("castlist")
      .select("book_id, issue_id, character, voice_id")
      .neq("book_id", BOOK)
      .like("voice_id", "dry-run-%"),
    "castlist fake voices",
  ) as unknown[];
  return [...appearances, ...cast].map((r) => JSON.stringify(r));
}

// ── Setup ───────────────────────────────────────────────────────────────
function castSpeakers(omitLegacyId: string | null) {
  const bubbles = loadIngestFixture().pages.flatMap((p) => p.bubbles);
  const omitted = omitLegacyId
    ? (bubbles.find((b) => b.legacyId === omitLegacyId)?.speaker ??
      fail(`no fixture bubble ${omitLegacyId} with a speaker`))
    : null;
  const speakers = new Set<string>();
  for (const b of bubbles) {
    // The context step writes "Narrator" for narration, and casting resolves
    // it to characters.narrator, so it is cast like tmnt-mmpr-iii's issues.
    const narration = b.type === "NARRATION" || b.type === "CAPTION";
    if (narration || normName(b.speaker ?? "") === "narrator") {
      speakers.add("Narrator");
    } else if (b.speaker) speakers.add(b.speaker);
  }
  if (omitted) speakers.delete(omitted);
  return { speakers: [...speakers].sort(), omitted };
}

async function setup(scenario: Scenario) {
  const src = must(
    await supabase
      .from("books")
      .select("franchises")
      .eq("id", SRC_BOOK)
      .single(),
    "source book",
  ) as { franchises: string[] | null };
  must(
    await supabase.from("books").insert({
      id: BOOK,
      name: "Smoke Test",
      slug: BOOK,
      franchises: src.franchises,
    }),
    "books insert",
  );
  // Real rows, so faces resolve and casting sees the speakers. smoke-stranger
  // gets none and stays unresolved in gates.
  const franchise = src.franchises?.[0] ?? null;
  must(
    await supabase
      .from("characters")
      .insert(fixtureIds().map((id) => ({ id, franchise, aliases: [] }))),
    "characters insert",
  );
  must(
    await insertIssue(supabase, {
      book_id: BOOK,
      id: ISSUE,
      number: 1,
      name: "Smoke",
    }),
    "issues insert",
  );

  for (const [i, srcNumber] of SRC_PAGES.entries()) {
    const number = i + 1;
    const srcPage = must(
      await supabase
        .from("pages")
        .select("width, height")
        .eq("book_id", SRC_BOOK)
        .eq("issue_id", SRC_ISSUE)
        .eq("number", srcNumber)
        .single(),
      `source page ${srcNumber}`,
    ) as { width: number; height: number };
    const to = pageStoragePath(BOOK, ISSUE, number);
    // Server-side copy keeps full size: fixture boxes are absolute pixels.
    must(
      await supabase.storage
        .from("comic-pages")
        .copy(pageStoragePath(SRC_BOOK, SRC_ISSUE, srcNumber), to),
      `copy page ${srcNumber}`,
    );
    must(
      await supabase.from("pages").insert({
        book_id: BOOK,
        issue_id: ISSUE,
        number,
        width: srcPage.width,
        height: srcPage.height,
        storage_path: to,
      }),
      `pages insert ${number}`,
    );
  }

  // Any cast voice works: TTS is faked, so which one does not matter.
  const voice = must(
    await supabase
      .from("castlist")
      .select("voice_id, voice_uuid")
      .eq("book_id", SRC_BOOK)
      .eq("issue_id", SRC_ISSUE)
      .not("voice_id", "is", null)
      .neq("voice_id", SKIPPED_VOICE)
      .limit(1)
      .single(),
    "source castlist voice",
  ) as { voice_id: string; voice_uuid: string | null };

  // castlist.character is the raw bubble speaker: the new-character queue
  // matches it exactly, casting matches it lowercased, audio by slug.
  const { speakers, omitted } = castSpeakers(scenario.omitCastForLegacyId);
  const row = (character: string) => ({
    book_id: BOOK,
    issue_id: ISSUE,
    character,
    ...voice,
  });
  must(
    await supabase.from("castlist").insert(speakers.map(row)),
    "castlist seed",
  );
  console.log(
    `setup: book, ${fixtureIds().length} characters, issue, ${SRC_PAGES.length} pages, castlist ${speakers.length} rows${omitted ? ` (left out: ${omitted})` : ""}`,
  );
  return { insertOmitted: omitted ? () => row(omitted) : null };
}

// ── Dev server ──────────────────────────────────────────────────────────
async function assertPortFree(why = "refusing to start"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", () =>
      reject(new SmokeFailure(`port ${PORT} is in use; ${why}`)),
    );
    srv.listen(PORT, () => srv.close(() => resolve()));
  });
}

async function startDevServer(tmp: string, dryScenario: string | null) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
    WORKFLOW_LOCAL_BASE_URL: BASE,
    // withWorkflow (next.config) forces `.next/workflow-data` unless the
    // world is already chosen; a shared dir keeps hook tokens of killed runs.
    WORKFLOW_TARGET_WORLD: "local",
    WORKFLOW_LOCAL_DATA_DIR: join(tmp, "workflow-data"),
    // Step retries log at info level only; this namespace makes them visible.
    DEBUG: "workflow:step:info",
    // No Slack post per pause from a smoke run.
    SLACK_BOT_TOKEN: "",
    SLACK_CHANNEL_ID: "",
  };
  delete env.SKIP_ENV_VALIDATION;
  if (dryScenario) {
    env.DRY_RUN = "1";
    env.DRY_RUN_SCENARIO = dryScenario;
    // Every API key is a placeholder, so an un-faked call fails at auth
    // instead of spending. Supabase vars and admin credentials stay real.
    for (const key of Object.keys(env)) {
      if (/API_KEY/.test(key)) env[key] = "placeholder-dry-run";
    }
    for (const key of REQUIRED_KEYS) env[key] ||= "placeholder-dry-run";
  } else {
    delete env.DRY_RUN;
    delete env.DRY_RUN_SCENARIO;
  }
  const logPath = join(tmp, "dev-server.log");
  const fd = openSync(logPath, "a");
  // Checked right before the spawn: the server on 3082 must be this child.
  await assertPortFree();
  checkStop();
  const child = (live.child = spawn("pnpm", ["dev", "-p", String(PORT)], {
    env,
    detached: true,
    stdio: ["ignore", fd, fd],
  }));
  child.on("error", (err) => (childError = err));
  console.log(`dev server: pid ${child.pid}, log ${logPath}`);
  return { child, logPath };
}

async function stopDevServer(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const kill = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      /* group already gone */
    }
  };
  kill("SIGTERM");
  await Promise.race([exited, sleep(10_000)]);
  kill("SIGKILL");
}

let childError: Error | null = null;

async function waitForServer(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    checkStop();
    if (childError) fail(`dev server spawn failed: ${childError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(
        `dev server exited (${child.exitCode ?? child.signalCode}) before answering`,
      );
    }
    try {
      await fetch(`${BASE}/api/admin/resume-hook`);
      return;
    } catch {
      await sleep(1000);
    }
  }
  fail(`dev server not answering on ${BASE} after 180s`);
}

function authHeaders(): Record<string, string> {
  const { ADMIN_USERNAME: u, ADMIN_PASSWORD: p } = process.env;
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (u && p) {
    h.Authorization = `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
  }
  return h;
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

function logHits(logPath: string): string[] {
  const lines = readFileSync(logPath, "utf8").split("\n");
  return lines.filter((l) => LOG_FAILURES.some((re) => re.test(l)));
}

/**
 * Error lines, the failing step name, and stack frames outside node_modules
 * (the repo's own code; under `next dev` a step's frame is a `.next` chunk,
 * and `stepName` names the source file).
 */
function logErrors(logPath: string): string[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(
      (l) =>
        /\[Workflow\]|stepName:|Error|failed/.test(l) ||
        (/\bat /.test(l) && !/node_modules|node:internal/.test(l)),
    )
    .map((l) => l.replaceAll(process.cwd(), "."))
    .slice(-40);
}

// ── Run ─────────────────────────────────────────────────────────────────
type IssueRow = {
  pipeline_step: string | null;
  pipeline_paused: boolean | null;
  pipeline_paused_at: string | null;
  status: string | null;
};

async function readIssue(): Promise<IssueRow> {
  return must(
    await selectIssue(
      supabase,
      BOOK,
      ISSUE,
      "pipeline_step, pipeline_paused, pipeline_paused_at, status",
    ).single(),
    "issue poll",
  ) as IssueRow;
}

async function resume(gate: string): Promise<void> {
  const step = PAUSE_TO_HOOK_STEP[gate] ?? gate;
  const deadline = Date.now() + RESUME_RETRY_MS;
  for (;;) {
    checkStop();
    const res = await post("/api/admin/resume-hook", {
      bookId: BOOK,
      issueId: ISSUE,
      step,
    });
    if (res.status === 200) return;
    if (res.status === 500) {
      fail(`resume-hook ${step}: 500 (finding): ${res.text}`);
    }
    if (res.status !== 404 || Date.now() > deadline) {
      fail(`resume-hook ${step}: ${res.status} ${res.text}`);
    }
    await sleep(2000);
  }
}

async function runPipeline(
  scenario: Scenario,
  logPath: string,
  insertOmitted: (() => Record<string, unknown>) | null,
  resumed: string[],
  run: { id?: string },
): Promise<void> {
  const trig = await post("/api/admin/trigger-ingest", {
    bookId: BOOK,
    issueId: ISSUE,
  });
  if (trig.status !== 200) {
    fail(
      `trigger-ingest: ${trig.status}${trig.status === 500 ? " (finding)" : ""} ${trig.text}`,
    );
  }
  console.log(`trigger-ingest: ${trig.text}`);
  run.id = (JSON.parse(trig.text) as { runId?: string }).runId;

  const pauses = scenario.gates.filter((g) => g.expect === "pause");
  const started = Date.now();
  let lastKey = "";
  let lastChange = Date.now();
  let row = await readIssue();
  for (;;) {
    checkStop();
    const hits = logHits(logPath);
    if (hits.length > 0) {
      fail(`server log shows a failure:\n  ${hits.join("\n  ")}`);
    }
    const step = row.pipeline_step ?? "";
    if (step.startsWith("failed:")) fail(`pipeline_step = ${step}`);
    if (step === "complete") return;

    const key = `${step}|${row.pipeline_paused}`;
    if (key !== lastKey) {
      lastKey = key;
      lastChange = Date.now();
      console.log(`  step: ${step}${row.pipeline_paused ? " (paused)" : ""}`);
    }
    const gate = row.pipeline_paused_at;
    if (row.pipeline_paused && gate && !resumed.includes(gate)) {
      const want = pauses[resumed.length]?.gate;
      if (gate !== want) {
        fail(`paused at ${gate}; expected ${want ?? "no more pauses"}`);
      }
      if (gate === "casting" && insertOmitted) {
        must(
          await supabase.from("castlist").insert(insertOmitted()),
          "castlist insert before casting resume",
        );
        console.log("  castlist: inserted the left-out row (owner simulation)");
      }
      await resume(gate);
      resumed.push(gate);
      console.log(`  ${gate}: paused→resumed`);
    }
    if (Date.now() - lastChange > GATE_TIMEOUT_MS) {
      fail(
        `per-gate timeout (${GATE_TIMEOUT_MS / 60_000} min) with no step change; last pipeline_step = ${step}`,
      );
    }
    if (Date.now() - started > RUN_TIMEOUT_MS) {
      fail(
        `whole-run timeout (${RUN_TIMEOUT_MS / 60_000} min); last pipeline_step = ${step}`,
      );
    }
    await sleep(3000);
    row = await readIssue();
  }
}

type RunRow = {
  status: string;
  completed_at: string | null;
  steps: { skipped?: Skip[] } | null;
};

/** This run's pipeline_runs row, matched on the trigger's runId. */
async function readRun(runId: string | undefined): Promise<RunRow | null> {
  if (!runId) return null;
  const rows = must(
    await supabase
      .from("pipeline_runs")
      .select("status, completed_at, steps")
      .eq("book_id", BOOK)
      .eq("issue_id", ISSUE)
      .eq("steps->>runId", runId),
    "pipeline_runs",
  ) as RunRow[];
  return rows[0] ?? null;
}

/** One line per expected gate; returns the mismatches. */
function gateReport(
  scenario: Scenario,
  resumed: string[],
  skipped: Skip[],
): string[] {
  const bad: string[] = [];
  for (const { gate, expect } of scenario.gates) {
    const skip = skipped.find((s) => s.gate === gate);
    const seen = resumed.includes(gate)
      ? "paused→resumed"
      : skip
        ? `skipped (${skip.reason})`
        : "not reached";
    const ok = seen.startsWith(expect === "pause" ? "paused" : "skipped");
    console.log(`gate ${gate}: ${seen}${ok ? "" : `  ✗ expected ${expect}`}`);
    if (!ok) bad.push(`${gate}: ${seen}, expected ${expect}`);
  }
  return bad;
}

// ── Assert ──────────────────────────────────────────────────────────────
async function assertRows(scenario: Scenario): Promise<string[]> {
  const bad: string[] = [];
  for (const [table, want] of Object.entries(scenario.counts)) {
    const n = await countOf(table, { book_id: BOOK, issue_id: ISSUE });
    console.log(`${table} = ${n}${n === want ? "" : `  ✗ expected ${want}`}`);
    if (n !== want) bad.push(`${table} = ${n}, expected ${want}`);
  }

  const scoped = (table: string, cols: string) =>
    supabase.from(table).select(cols).eq("book_id", BOOK).eq("issue_id", ISSUE);
  const bubbles = must(
    await scoped(
      "bubbles",
      "id, speaker, ignored, ocr_text, style, audio_storage_path",
    ),
    "bubbles",
  ) as unknown as Array<{
    id: string;
    speaker: string | null;
    ignored: boolean | null;
    ocr_text: string | null;
    style: unknown;
    audio_storage_path: string | null;
  }>;
  const noText = bubbles.filter((b) => !b.ocr_text || b.style == null);
  console.log(`bubbles without ocr_text or style = ${noText.length}`);
  if (noText.length > 0) {
    bad.push(`${noText.length} bubbles lack ocr_text or style`);
  }

  const cast = must(
    await scoped("castlist", "character, voice_id"),
    "castlist",
  ) as unknown as Array<{ character: string; voice_id: string | null }>;
  const voiced = new Set(
    cast
      .filter((c) => c.voice_id && c.voice_id !== SKIPPED_VOICE)
      .map((c) => slugify(c.character)),
  );
  const stamps = new Set(
    (
      must(
        await scoped("audio_timestamps", "bubble_id"),
        "audio_timestamps",
      ) as unknown as Array<{ bubble_id: string }>
    ).map((t) => t.bubble_id),
  );
  const files = new Set(
    (await listObjects("comic-audio", `${BOOK}/${ISSUE}`)).map((p) =>
      p.split("/").pop(),
    ),
  );
  const castBubbles = bubbles.filter(
    (b) => !b.ignored && b.speaker && voiced.has(slugify(b.speaker)),
  );
  const missing = castBubbles.filter(
    (b) =>
      !b.audio_storage_path ||
      !stamps.has(b.id) ||
      !files.has(b.audio_storage_path),
  );
  // Every fixture bubble with text has a cast speaker (Narrator included),
  // except the stranger's; so zero cast bubbles cannot pass.
  const want =
    loadIngestFixture()
      .pages.flatMap((p) => p.bubbles)
      .filter((b) => b.ocrText).length - scenario.strangerBubbles;
  console.log(
    `cast bubbles = ${castBubbles.length} (fixture implies ${want}), with audio + audio_timestamps + mp3 = ${castBubbles.length - missing.length}`,
  );
  if (castBubbles.length !== want) {
    bad.push(`cast bubbles = ${castBubbles.length}, expected ${want}`);
  }
  if (missing.length > 0) {
    bad.push(`${missing.length} cast bubbles lack audio or timestamps`);
  }
  const stranger = bubbles.filter((b) => b.speaker === "Smoke Stranger");
  if (stranger.length > 0) {
    const withAudio = stranger.filter((b) => b.audio_storage_path).length;
    console.log(
      `Smoke Stranger bubbles = ${stranger.length}, with audio = ${withAudio} (uncast, so none expected)`,
    );
  }

  const issue = await readIssue();
  console.log(`issues.status = ${issue.status}`);
  if (issue.status !== "ready") bad.push(`issues.status = ${issue.status}`);

  // Smoke ids may carry dry-run voices until cleanup; nothing else may.
  const fakes = await fakeVoiceRows(true);
  console.log(
    `dry-run voice ids outside the smoke ids = ${fakes.length} (smoke rows may carry one until cleanup)`,
  );
  for (const r of fakes) bad.push(`fake voice id in a shared row: ${r}`);
  return bad;
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function listObjects(bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const items = must(
      await supabase.storage.from(bucket).list(prefix, { limit: 1000, offset }),
      `list ${bucket}/${prefix}`,
    );
    for (const item of items) {
      const path = `${prefix}/${item.name}`;
      // Folders come back with a null id.
      if (item.id === null) out.push(...(await listObjects(bucket, path)));
      else out.push(path);
    }
    if (items.length < 1000) return out;
  }
}

/** Every smoke-owned book row set, in FK-safe delete order. */
const SMOKE_ROWS: Array<[string, Eqs]> = [
  ...BOOK_TABLES.map((t): [string, Eqs] => [t, { book_id: BOOK }]),
  ["books", { id: BOOK }],
  ["aliases", { scope: "book", scope_id: BOOK }],
];
/**
 * Global rows keyed on a smoke id, deleted after the book rows (bubbles,
 * casting_tasks, character_face_exemplars and panel_character_detections
 * also reference characters.id). The prefix filter is a second guard.
 */
const smokeGlobal = (del: boolean) =>
  (
    [
      ["character_appearances", "character_id"],
      ["characters", "id"],
    ] as const
  ).map(([table, column]) => {
    const q = del
      ? supabase.from(table).delete()
      : supabase.from(table).select("*", { count: "exact", head: true });
    return [
      table,
      q.in(column, smokeIds()).like(column, `${PREFIX}%`),
    ] as const;
  });

async function cleanup(): Promise<{ rows: number; objects: number }> {
  // panels.scene_id and music_scenes reference each other.
  must(
    await supabase
      .from("panels")
      .update({ scene_id: null })
      .eq("book_id", BOOK),
    "panels.scene_id null",
  );
  // panel_character_detections cascades from panels.
  for (const [table, eqs] of SMOKE_ROWS) {
    const res =
      table === "issues"
        ? await deleteIssue(supabase, BOOK, ISSUE)
        : await withEqs(supabase.from(table).delete(), eqs);
    must(res, `delete ${table}`);
  }
  for (const [table, q] of smokeGlobal(true)) {
    must(await q, `delete ${table} (smoke ids)`);
  }
  for (const bucket of BUCKETS) {
    const paths = await listObjects(bucket, BOOK);
    for (let i = 0; i < paths.length; i += 100) {
      must(
        await supabase.storage.from(bucket).remove(paths.slice(i, i + 100)),
        `remove ${bucket}`,
      );
    }
  }
  return remaining();
}

/** Smoke rows and objects still present, book-scoped and global. */
async function remaining(): Promise<{ rows: number; objects: number }> {
  let rows = 0;
  const add = (table: string, n: number) => {
    if (n) console.log(`  remaining ${table}: ${n}`);
    rows += n;
  };
  for (const [table, eqs] of SMOKE_ROWS) {
    add(
      table,
      table === "issues"
        ? must(await listBookIssues(supabase, BOOK, "id"), "issues").length
        : await countOf(table, eqs),
    );
  }
  for (const [table, q] of smokeGlobal(false)) {
    const { count, error } = await q;
    if (error) fail(`${table} count: ${error.message}`);
    add(`${table} (smoke ids)`, count ?? 0);
  }
  let objects = 0;
  for (const bucket of BUCKETS) {
    const n = (await listObjects(bucket, BOOK)).length;
    if (n) console.log(`  remaining ${bucket}/${BOOK}/: ${n}`);
    objects += n;
  }
  return { rows, objects };
}

// ── Spend estimate for --real (#97) ─────────────────────────────────────
function printEstimate(): void {
  const pages = loadIngestFixture().pages;
  const bubbles = pages.flatMap((p) => p.bubbles);
  const faces = pages.flatMap((p) => p.faces).length;
  const chars = bubbles.reduce((n, b) => n + b.ocrText.length, 0);
  const speakers = castSpeakers(null).speakers.length;
  console.log(
    [
      "spend estimate for a real run (fixture sizes, no retries):",
      `  Roboflow: ${SRC_PAGES.length} pages (≈ $0.003/page)`,
      `  Gemini: ≈ ${bubbles.length * 2 + faces + SRC_PAGES.length + speakers} requests (OCR + context per bubble, face ID, sort, voice descriptions) plus embeddings`,
      `  ElevenLabs: ≈ ${chars} TTS characters; Voice Design only for speakers without a ready voice`,
    ].join("\n"),
  );
}

// ── Main ────────────────────────────────────────────────────────────────
const CLEANUP_CMD =
  "pnpm exec tsx --env-file=.env scripts/smoke-ingest.ts --cleanup-only";
const CLEANUP_TIMEOUT_MS = 3 * 60_000;

/** The one cleanup path; any count but 0, a failure or the time limit prints the fix. */
async function runCleanup(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new SmokeFailure(
            `cleanup timed out after ${CLEANUP_TIMEOUT_MS / 1000}s`,
          ),
        ),
      CLEANUP_TIMEOUT_MS,
    );
  });
  try {
    const c = await Promise.race([cleanup(), limit]);
    console.log(`cleanup: ${c.rows} rows, ${c.objects} objects`);
    if (c.rows + c.objects === 0) return true;
  } catch (err) {
    console.log(`cleanup failed: ${errText(err)}`);
  } finally {
    clearTimeout(timer);
  }
  console.log(`run: ${CLEANUP_CMD}`);
  return false;
}

async function main(): Promise<number> {
  if (flag("--cleanup-only")) {
    try {
      await assertPortFree(
        "a smoke run or its dev server may still be alive; stop it first",
      );
    } catch (err) {
      console.error(errText(err));
      return 1;
    }
    return (await runCleanup()) ? 0 : 1;
  }
  if (real || confirmSpend) {
    printEstimate();
    if (!(real && confirmSpend)) {
      console.error(
        "refusing: a real run needs both --real and --confirm-spend",
      );
      return 1;
    }
  }
  if (scenarioName !== "clean" && scenarioName !== "gates") {
    console.error("usage: --scenario clean|gates [--keep] | --cleanup-only");
    return 1;
  }
  const scenario = JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        "fixtures",
        "ingest",
        "smoke",
        `${scenarioName}.json`,
      ),
      "utf8",
    ),
  ) as Scenario;

  const problems: string[] = [];
  let logPath: string | null = null;
  const resumed: string[] = [];
  const runRef: { id?: string } = {};
  let before: Snapshot | null = null;
  let tmp: string | null = null;
  let wrote = false;
  try {
    await assertSmokeIds();
    await assertPortFree();
    const leftover = await remaining();
    if (leftover.rows + leftover.objects > 0) {
      fail(
        `${leftover.rows} rows and ${leftover.objects} objects left by an earlier run. Run --cleanup-only first.`,
      );
    }
    before = await snapshot();
    checkStop();
    wrote = true;
    const { insertOmitted } = await setup(scenario);
    checkStop();
    tmp = mkdtempSync(join(tmpdir(), "smoke-ingest-"));
    const dev = await startDevServer(tmp, real ? null : scenarioName);
    logPath = dev.logPath;
    checkStop();
    await waitForServer(dev.child);
    await runPipeline(scenario, logPath, insertOmitted, resumed, runRef);
    console.log("pipeline_step = complete");
  } catch (err) {
    problems.push(errText(err));
  } finally {
    if (live.child) await stopDevServer(live.child);
  }

  try {
    if (wrote && !stopping) {
      const run = await readRun(runRef.id);
      problems.push(
        ...gateReport(scenario, resumed, run?.steps?.skipped ?? []),
      );
      if (problems.length === 0) problems.push(...(await assertRows(scenario)));
      const closed = run?.status === "completed" && run.completed_at !== null;
      console.log(
        `pipeline_runs (runId ${runRef.id ?? "none"}): status = ${run?.status ?? "no row"}, completed_at = ${run?.completed_at ?? "null"}`,
      );
      if (!closed) problems.push("pipeline_runs row is not completed");
    }
  } catch (err) {
    problems.push(errText(err));
  } finally {
    if (logPath && problems.length > 0) {
      console.log(`server log errors (${logPath}):`);
      for (const l of logErrors(logPath)) console.log(`  ${l}`);
    }
    if (wrote && flag("--keep")) {
      console.log(
        `cleanup, isolation and dry-run checks: skipped (--keep leaves the smoke rows in place)\nclean up later with: ${CLEANUP_CMD}`,
      );
    } else if (wrote && !(await runCleanup())) {
      problems.push("cleanup left rows or objects");
    }
    if (before && !flag("--keep")) {
      const diffs = diffSnapshots(before, await snapshot());
      console.log(`isolation: ${diffs.length === 0 ? "unchanged" : "CHANGED"}`);
      for (const d of diffs) problems.push(`isolation: ${d}`);
      const fakes = await fakeVoiceRows(false);
      console.log(
        `dry-run voice ids after cleanup = ${fakes.length} (smoke rows included)`,
      );
      for (const r of fakes) problems.push(`fake voice id left: ${r}`);
    }
  }
  if (stopping && !problems.includes(INTERRUPTED)) problems.push(INTERRUPTED);
  if (tmp && problems.length === 0) {
    rmSync(join(tmp, "workflow-data"), { recursive: true, force: true });
    console.log(`server log kept: ${logPath}`);
  } else if (tmp) {
    console.log(`kept for inspection: ${tmp} (server log and workflow-data)`);
  }

  console.log(
    `\nsmoke ${scenarioName}: ${problems.length === 0 ? "PASS" : "FAIL"}`,
  );
  for (const p of problems) console.log(`  ✗ ${p}`);
  return problems.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
