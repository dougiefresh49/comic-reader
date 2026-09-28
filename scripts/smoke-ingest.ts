/**
 * Smoke-test the ingest workflow through every gate (#92). Seeds book
 * `smoke-test` / `issue-smoke` from two tmnt-mmpr-iii pages, runs the
 * pipeline on a fresh `pnpm dev` under DRY_RUN, resumes each gate, asserts
 * the rows the reader needs, then deletes everything it wrote.
 *
 * Writes only under book_id 'smoke-test' and the `smoke-test/` Storage prefix
 * (decision row 84). Global tables are read, never written.
 *
 * Usage:
 *   pnpm exec tsx --env-file=.env scripts/smoke-ingest.ts --scenario clean|gates [--keep]
 *   pnpm exec tsx --env-file=.env scripts/smoke-ingest.ts --cleanup-only
 *   ... --real --confirm-spend   (#97 only: no DRY_RUN, paid calls)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAUSE_TO_HOOK_STEP } from "~/app/api/admin/cancel-ingest/hooks";
import { loadIngestFixture } from "~/lib/fakes/dry-run";
import {
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
};
type Skip = { gate: string; reason: string };

class SmokeFailure extends Error {}
const fail = (msg: string): never => {
  throw new SmokeFailure(msg);
};

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

// ── Precondition: fixtures carry made-up character ids (#186, row 77) ──
const normName = (s: string) =>
  s.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();

async function assertMadeUpIds(): Promise<void> {
  const fixture = loadIngestFixture();
  const names = new Set<string>();
  for (const p of fixture.pages) {
    for (const b of p.bubbles) if (b.speaker) names.add(b.speaker);
    for (const f of p.faces) names.add(f.characterName);
  }
  const rows = must(
    await supabase.from("characters").select("id, aliases"),
    "characters select",
  ) as Array<{ id: string; aliases: string[] | null }>;
  const hits: string[] = [];
  for (const name of names) {
    const n = normName(name);
    if (!n || n === "narrator") continue;
    for (const c of rows) {
      const match = [c.id, ...(c.aliases ?? [])].find((v) => {
        const m = normName(v);
        return m && (m.includes(n) || n.includes(m));
      });
      if (match) hits.push(`${name} ~ characters.${c.id} (${match})`);
    }
  }
  if (hits.length > 0) {
    fail(
      `fixtures/ingest/pages.json names production characters (#186 not merged?); refusing to start:\n  ${hits.slice(0, 20).join("\n  ")}${hits.length > 20 ? `\n  ... ${hits.length - 20} more` : ""}`,
    );
  }
}

// ── Isolation snapshot ──────────────────────────────────────────────────
async function snapshot(): Promise<Record<string, string>> {
  const issues = must(await listAllIssues(supabase, "*"), "issues snapshot")
    .filter((r) => r.book_id !== BOOK)
    .map((r) => JSON.stringify(r))
    .sort();
  return {
    "other books' issues": issues.join("\n"),
    characters: String(await countOf("characters")),
    character_appearances: String(await countOf("character_appearances")),
    voices: String(await countOf("voices")),
    "global aliases": String(await countOf("aliases", { scope: "global" })),
  };
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
    `setup: book, issue, ${SRC_PAGES.length} pages, castlist ${speakers.length} rows${omitted ? ` (left out: ${omitted})` : ""}`,
  );
  return { insertOmitted: omitted ? () => row(omitted) : null };
}

// ── Dev server ──────────────────────────────────────────────────────────
async function assertPortFree(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", () =>
      reject(new SmokeFailure(`port ${PORT} is in use; refusing to start`)),
    );
    srv.listen(PORT, () => srv.close(() => resolve()));
  });
}

function startDevServer(tmp: string, dryScenario: string | null) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
    WORKFLOW_LOCAL_BASE_URL: BASE,
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
    for (const key of REQUIRED_KEYS) env[key] ||= "placeholder-dry-run";
  } else {
    delete env.DRY_RUN;
    delete env.DRY_RUN_SCENARIO;
  }
  const logPath = join(tmp, "dev-server.log");
  const fd = openSync(logPath, "a");
  const child = spawn("pnpm", ["dev", "-p", String(PORT)], {
    env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
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

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
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

  const pauses = scenario.gates.filter((g) => g.expect === "pause");
  const started = Date.now();
  let lastKey = "";
  let lastChange = Date.now();
  let row = await readIssue();
  for (;;) {
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

async function readRun(): Promise<{ status: string; skipped: Skip[] } | null> {
  const rows = must(
    await supabase
      .from("pipeline_runs")
      .select("status, steps")
      .eq("book_id", BOOK)
      .eq("issue_id", ISSUE)
      .order("started_at", { ascending: false })
      .limit(1),
    "pipeline_runs",
  ) as Array<{ status: string; steps: { skipped?: Skip[] } | null }>;
  const r = rows[0];
  return r ? { status: r.status, skipped: r.steps?.skipped ?? [] } : null;
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
  console.log(
    `cast bubbles = ${castBubbles.length}, with audio + audio_timestamps + mp3 = ${castBubbles.length - missing.length}`,
  );
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

  const fakeVoices = must(
    await supabase
      .from("character_appearances")
      .select("id, character_id, voice_id")
      .like("voice_id", "dry-run-%"),
    "character_appearances fake voices",
  ) as unknown[];
  const fakeCast = must(
    await supabase
      .from("castlist")
      .select("book_id, issue_id, character, voice_id")
      .neq("book_id", BOOK)
      .like("voice_id", "dry-run-%"),
    "castlist fake voices",
  ) as unknown[];
  console.log(
    `dry-run voice ids: character_appearances = ${fakeVoices.length}, castlist outside ${BOOK} = ${fakeCast.length}`,
  );
  for (const r of [...fakeVoices, ...fakeCast]) {
    bad.push(`fake voice id in a shared row: ${JSON.stringify(r)}`);
  }
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

/** Every smoke-owned row set, in FK-safe delete order. */
const SMOKE_ROWS: Array<[string, Eqs]> = [
  ...BOOK_TABLES.map((t): [string, Eqs] => [t, { book_id: BOOK }]),
  ["books", { id: BOOK }],
  ["aliases", { scope: "book", scope_id: BOOK }],
];

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
        ? // issue-queries.ts has no delete helper; both keys filter it.
          // eslint-disable-next-line no-restricted-syntax
          await supabase
            .from("issues")
            .delete()
            .eq("book_id", BOOK)
            .eq("id", ISSUE)
        : await withEqs(supabase.from(table).delete(), eqs);
    must(res, `delete ${table}`);
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

  let rows = 0;
  for (const [table, eqs] of SMOKE_ROWS) {
    const n =
      table === "issues"
        ? must(await listBookIssues(supabase, BOOK, "id"), "issues").length
        : await countOf(table, eqs);
    if (n) console.log(`  remaining ${table}: ${n}`);
    rows += n;
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
async function main(): Promise<number> {
  if (flag("--cleanup-only")) {
    const c = await cleanup();
    console.log(`cleanup: ${c.rows} rows, ${c.objects} objects`);
    return c.rows + c.objects === 0 ? 0 : 1;
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
  let child: ChildProcess | null = null;
  let logPath: string | null = null;
  const resumed: string[] = [];
  let before: Record<string, string> | null = null;
  let wrote = false;
  try {
    if (!real) await assertMadeUpIds();
    await assertPortFree();
    const leftover = await cleanup();
    if (leftover.rows + leftover.objects > 0) {
      fail(`pre-run cleanup left ${leftover.rows} rows`);
    }
    before = await snapshot();
    wrote = true;
    const { insertOmitted } = await setup(scenario);
    const tmp = mkdtempSync(join(tmpdir(), "smoke-ingest-"));
    const dev = startDevServer(tmp, real ? null : scenarioName);
    child = dev.child;
    logPath = dev.logPath;
    await waitForServer();
    await runPipeline(scenario, logPath, insertOmitted, resumed);
    console.log("pipeline_step = complete");
  } catch (err) {
    if (!(err instanceof SmokeFailure)) throw err;
    problems.push(err.message);
  } finally {
    if (child) await stopDevServer(child);
  }

  try {
    if (wrote) {
      const run = await readRun();
      problems.push(...gateReport(scenario, resumed, run?.skipped ?? []));
      if (problems.length === 0) problems.push(...(await assertRows(scenario)));
      if (run?.status === "running") {
        console.log(
          "finding: pipeline_runs.status is still 'running' (nothing sets it to complete); not asserted",
        );
      }
    }
  } catch (err) {
    if (!(err instanceof SmokeFailure)) throw err;
    problems.push(err.message);
  } finally {
    if (logPath && problems.length > 0) {
      console.log(`server log errors (${logPath}):`);
      for (const l of logErrors(logPath)) console.log(`  ${l}`);
    }
    if (wrote && !flag("--keep")) {
      const c = await cleanup();
      console.log(`cleanup: ${c.rows} rows, ${c.objects} objects`);
      if (c.rows + c.objects > 0) problems.push("cleanup left rows or objects");
    } else if (wrote) {
      console.log("cleanup: skipped (--keep)");
    }
    if (before) {
      const after = await snapshot();
      const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
      console.log(
        `isolation: ${changed.length === 0 ? "unchanged" : `CHANGED ${changed.join(", ")}`}`,
      );
      if (changed.length > 0) problems.push(`isolation: ${changed.join(", ")}`);
    }
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
