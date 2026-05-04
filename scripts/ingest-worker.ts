#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import { createServer } from "http";
import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

const POLL_INTERVAL = parseInt(process.env.WORKER_POLL_INTERVAL ?? "30000", 10);
const WORKER_PORT = parseInt(process.env.WORKER_PORT ?? "7777", 10);
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } },
);

const RAW_BUCKET = "comic-pages-raw";

interface WorkerState {
  status: "idle" | "running";
  currentJob: { book: string; issue: string; step: string } | null;
}

const state: WorkerState = { status: "idle", currentJob: null };

const PIPELINE_STEPS = [
  "validate-inputs",
  "generate-pages-metadata",
  "convert-pages-to-webp",
  "roboflow-page-analyze",
  "extract-foreground-masks",
  "character-lookahead",
  "get-context",
  "review-speakers",
  "sort-bubbles-gemini",
  "add-bubble-styles",
  "generate-character-voice-descriptions",
  "clean-voice-descriptions",
  "review-new-characters",
  "find-voice-sources",
  "generate-voice-models",
  "voice-rotation-checkout",
  "generate-audio",
  "copy-to-public",
  "consolidate-music-scenes",
  "voice-rotation-archive",
  "generate-manifest",
];

const PAUSE_STEPS = new Set([
  "review-speakers",
  "review-new-characters",
  "generate-voice-models",
]);

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function pauseUrl(bookId: string, issueId: string, step: string): string {
  if (step === "review-speakers") {
    return `${BASE_URL}/admin/${bookId}/${issueId}/review/speakers`;
  }
  if (step === "review-new-characters") {
    return `${BASE_URL}/admin/${bookId}/${issueId}/review/characters`;
  }
  if (step === "generate-voice-models") {
    return `${BASE_URL}/admin/${bookId}/${issueId}/review/voices`;
  }
  return `${BASE_URL}/admin`;
}

async function runPnpmScript(
  scriptName: string,
  book: string,
  issue: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [scriptName, "--", `--book=${book}`, `--issue=${issue}`, "--auto"],
      {
        stdio: "inherit",
        env: { ...process.env, COMIC_BOOK: book, COMIC_ISSUE: issue },
        cwd: PROJECT_ROOT,
      },
    );

    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (err) =>
      reject(new Error(`Failed to start "${scriptName}": ${err.message}`)),
    );
  });
}

async function downloadSourcePages(
  bookId: string,
  issueId: string,
): Promise<void> {
  const issueDir = join(
    PROJECT_ROOT,
    "assets",
    "comics",
    bookId,
    issueId,
    "pages",
  );
  await fs.ensureDir(issueDir);

  const prefix = `${bookId}/${issueId}/source/`;
  const { data: files, error } = await supabase.storage
    .from(RAW_BUCKET)
    .list(`${bookId}/${issueId}/source`);

  if (error || !files) {
    throw new Error(`Failed to list source pages: ${error?.message}`);
  }

  const pageFiles = files.filter((f) =>
    /^page-\d+\.(jpg|jpeg|png|webp)$/i.test(f.name),
  );
  log(`  Downloading ${pageFiles.length} source pages...`);

  for (const file of pageFiles) {
    const { data, error: dlError } = await supabase.storage
      .from(RAW_BUCKET)
      .download(`${prefix}${file.name}`);

    if (dlError || !data) {
      log(`  Warning: failed to download ${file.name}: ${dlError?.message}`);
      continue;
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    await fs.writeFile(join(issueDir, file.name), buffer);
  }

  log(`  Downloaded ${pageFiles.length} pages to ${issueDir}`);
}

async function updateIssue(
  issueId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("issues")
    .update(updates)
    .eq("id", issueId);

  if (error) {
    log(`  Warning: failed to update issue: ${error.message}`);
  }
}

async function waitForUnpause(issueId: string): Promise<void> {
  log("  Waiting for human review...");
  while (true) {
    await new Promise((r) => setTimeout(r, 15000));

    const { data } = (await supabase
      .from("issues")
      .select("pipeline_paused")
      .eq("id", issueId)
      .single()) as { data: { pipeline_paused: boolean } | null };

    if (data && !data.pipeline_paused) {
      log("  Review complete — resuming pipeline");
      return;
    }
  }
}

async function validateInputs(book: string, issue: string): Promise<void> {
  const pagesDir = join(PROJECT_ROOT, "assets", "comics", book, issue, "pages");
  if (!(await fs.pathExists(pagesDir))) {
    throw new Error(`Pages directory not found: ${pagesDir}`);
  }
  const files = await fs.readdir(pagesDir);
  const pageFiles = files.filter((f) => /^page-\d+\.(jpg|jpeg|png)$/i.test(f));
  if (pageFiles.length === 0) {
    throw new Error(`No page images found in: ${pagesDir}`);
  }
  log(`  Found ${pageFiles.length} page images`);
}

async function processIssue(issueId: string, bookId: string): Promise<void> {
  const issue = `issue-${issueId.replace("issue-", "")}`;

  log(`Starting pipeline for ${bookId}/${issue}`);
  state.status = "running";
  state.currentJob = { book: bookId, issue, step: "downloading" };

  await updateIssue(issueId, {
    pipeline_step: "downloading-pages",
    pipeline_paused: false,
  });

  await downloadSourcePages(bookId, issue);

  const pkg = (await fs.readJson(join(PROJECT_ROOT, "package.json"))) as {
    scripts: Record<string, string>;
  };

  for (const step of PIPELINE_STEPS) {
    state.currentJob = { book: bookId, issue, step };

    await updateIssue(issueId, {
      pipeline_step: step,
      pipeline_paused: false,
    });

    log(`  Running: ${step}`);

    if (step === "validate-inputs") {
      await validateInputs(bookId, issue);
    } else if (!pkg.scripts[step]) {
      log(`  Skipping: no script "${step}" in package.json`);
    } else {
      const exitCode = await runPnpmScript(step, bookId, issue);

      if (exitCode === 2 && PAUSE_STEPS.has(step)) {
        log(`  Pipeline paused at ${step} — waiting for browser review`);
        await updateIssue(issueId, {
          pipeline_paused: true,
          pipeline_paused_at: step,
          pipeline_paused_url: pauseUrl(bookId, issueId, step),
        });

        await waitForUnpause(issueId);
        continue;
      }

      if (exitCode !== 0) {
        log(`  FAILED at ${step} (exit code ${exitCode})`);
        await updateIssue(issueId, {
          pipeline_step: `failed:${step}`,
          pipeline_paused: false,
        });
        state.status = "idle";
        state.currentJob = null;
        return;
      }
    }

    log(`  Completed: ${step}`);
  }

  await updateIssue(issueId, {
    pipeline_step: "complete",
    status: "ready",
    pipeline_paused: false,
    pipeline_paused_at: null,
    pipeline_paused_url: null,
  });

  log(`Pipeline complete for ${bookId}/${issue}`);
  state.status = "idle";
  state.currentJob = null;
}

async function pollForWork(): Promise<void> {
  if (state.status === "running") return;

  const { data } = (await supabase
    .from("issues")
    .select("id, book_id")
    .eq("pipeline_step", "queued")
    .eq("pipeline_paused", false)
    .order("created_at", { ascending: true })
    .limit(1)) as { data: { id: string; book_id: string }[] | null };

  if (!data || data.length === 0) return;

  const job = data[0]!;
  try {
    await processIssue(job.id, job.book_id);
  } catch (err) {
    log(
      `Error processing ${job.book_id}/${job.id}: ${err instanceof Error ? err.message : err}`,
    );
    await updateIssue(job.id, {
      pipeline_step: `failed:error`,
      pipeline_paused: false,
    });
    state.status = "idle";
    state.currentJob = null;
  }
}

function startHealthServer(): void {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(WORKER_PORT, () => {
    log(`Health server on http://localhost:${WORKER_PORT}/health`);
  });
}

async function main() {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SECRET_KEY
  ) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
    process.exit(1);
  }

  log("Ingest worker starting");
  log(`Poll interval: ${POLL_INTERVAL}ms`);
  log(`Base URL: ${BASE_URL}`);

  startHealthServer();

  while (true) {
    try {
      await pollForWork();
    } catch (err) {
      log(`Poll error: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
