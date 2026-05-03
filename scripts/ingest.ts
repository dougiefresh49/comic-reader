#!/usr/bin/env node

/**
 * Pipeline orchestrator for comic book ingestion.
 * Runs all processing steps in order with checkpoint/resume support.
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import * as readline from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

interface Checkpoint {
  book: string;
  issue: string;
  completedSteps: string[];
  lastCompletedAt: string | null;
  failedStep: string | null;
  currentStep: string | null;
}

interface PipelineStep {
  id: string;
  humanPause?: boolean;
  pauseMessage?: string;
}

const PIPELINE_STEPS: PipelineStep[] = [
  { id: "validate-inputs" },
  { id: "generate-pages-metadata" },
  { id: "convert-pages-to-webp" },
  { id: "roboflow-page-analyze" },
  { id: "extract-foreground-masks" },
  { id: "character-lookahead" },
  { id: "get-context" },
  { id: "review-speakers" },
  { id: "sort-bubbles-gemini" },
  { id: "add-bubble-styles" },
  { id: "generate-character-voice-descriptions" },
  { id: "clean-voice-descriptions" },
  { id: "review-new-characters" },
  { id: "find-voice-sources" },
  {
    id: "generate-voice-models",
    humanPause: true,
    pauseMessage:
      "Voice sources saved to data/source-material.json.\nDownload clips for characters marked 'needs_clips', then press Enter to generate voice models.",
  },
  { id: "voice-rotation-checkout" },
  { id: "generate-audio" },
  { id: "copy-to-public" },
  { id: "consolidate-music-scenes" },
  { id: "voice-rotation-archive" },
  { id: "generate-manifest" },
];

function parseArgs(): {
  book: string;
  issue: string;
  fromStep?: string;
  dryRun: boolean;
  auto: boolean;
} {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: pnpm ingest -- --book <name> --issue <n> [options]

Options:
  --book=NAME, --book NAME     Book name (required)
  --issue=N, --issue N         Issue number (required)
  --from-step=ID               Force restart from a specific step ID
  --dry-run                    Preview what would run without executing
  --auto                       Skip interactive prompts (prune-only for review-new-characters)
                               With STORAGE_MODE=supabase, review-new-characters uses --db (browser pause)
  --help, -h                   Show this help message

Pipeline steps:
${PIPELINE_STEPS.map((s, i) => `  ${i + 1}. ${s.id}${s.humanPause ? " [human pause]" : ""}`).join("\n")}

Examples:
  pnpm ingest -- --book tmnt-mmpr --issue 4
  pnpm ingest -- --book tmnt-mmpr --issue 4 --from-step generate-audio
  pnpm ingest -- --book tmnt-mmpr --issue 4 --dry-run
  pnpm ingest -- --book tmnt-mmpr --issue 4 --auto
`);
    process.exit(0);
  }

  let book = "";
  let issue = "";
  let fromStep: string | undefined;
  let dryRun = false;
  let auto = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith("--book=")) {
      book = arg.split("=")[1]?.trim() ?? "";
    }
    if (arg === "--book") {
      book = args[i + 1]?.trim() ?? "";
    }
    if (arg.startsWith("--issue=")) {
      const issueNum = arg.split("=")[1]?.trim() ?? "";
      issue = issueNum.startsWith("issue-") ? issueNum : `issue-${issueNum}`;
    }
    if (arg === "--issue") {
      const issueNum = args[i + 1]?.trim() ?? "";
      issue = issueNum.startsWith("issue-") ? issueNum : `issue-${issueNum}`;
    }
    if (arg.startsWith("--from-step=")) {
      fromStep = arg.split("=")[1]?.trim();
    }
    if (arg === "--from-step") {
      fromStep = args[i + 1]?.trim();
    }
    if (arg === "--dry-run") {
      dryRun = true;
    }
    if (arg === "--auto") {
      auto = true;
    }
  }

  if (!book) {
    console.error("❌ --book is required");
    process.exit(1);
  }
  if (!issue) {
    console.error("❌ --issue is required");
    process.exit(1);
  }

  return { book, issue, fromStep, dryRun, auto };
}

function checkpointPath(book: string, issue: string): string {
  return join(PROJECT_ROOT, "assets", "comics", book, issue, "checkpoint.json");
}

async function readCheckpoint(
  book: string,
  issue: string,
): Promise<Checkpoint> {
  const path = checkpointPath(book, issue);
  try {
    const data = await fs.readFile(path, "utf-8");
    return JSON.parse(data) as Checkpoint;
  } catch {
    return {
      book,
      issue,
      completedSteps: [],
      lastCompletedAt: null,
      failedStep: null,
      currentStep: null,
    };
  }
}

async function writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
  const path = checkpointPath(checkpoint.book, checkpoint.issue);
  await fs.ensureDir(dirname(path));
  await fs.writeFile(path, JSON.stringify(checkpoint, null, 2));
}

async function runPnpmScript(
  scriptName: string,
  book: string,
  issue: string,
  extraArgs: string[] = [],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      COMIC_BOOK: book,
      COMIC_ISSUE: issue,
    };

    const child = spawn(
      "pnpm",
      [scriptName, "--", `--book=${book}`, `--issue=${issue}`, ...extraArgs],
      {
        stdio: "inherit",
        env,
        cwd: PROJECT_ROOT,
      },
    );

    child.on("close", (code) => {
      resolve(code ?? 1);
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to start "${scriptName}": ${err.message}`));
    });
  });
}

async function checkPagesExist(book: string, issue: string): Promise<boolean> {
  const pagesDir = join(PROJECT_ROOT, "assets", "comics", book, issue, "pages");
  if (!(await fs.pathExists(pagesDir))) return false;
  const files = await fs.readdir(pagesDir);
  return files.some((f) => /^page-\d+\.(jpg|jpeg|png|webp)$/i.test(f));
}

async function validateInputs(book: string, issue: string): Promise<void> {
  const issueDir = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const pagesDir = join(issueDir, "pages");

  if (!(await fs.pathExists(issueDir))) {
    throw new Error(`Issue directory not found: ${issueDir}`);
  }

  if (!(await fs.pathExists(pagesDir))) {
    throw new Error(`Pages directory not found: ${pagesDir}`);
  }

  const files = await fs.readdir(pagesDir);
  const pageFiles = files.filter((f) => /^page-\d+\.(jpg|jpeg|png)$/i.test(f));

  if (pageFiles.length === 0) {
    throw new Error(`No page images found in: ${pagesDir}`);
  }

  console.log(`   ✓ Found ${pageFiles.length} page images in ${pagesDir}`);
}

async function promptContinue(message: string): Promise<void> {
  console.log(`\n⏸️  HUMAN PAUSE\n`);
  console.log(message);
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("Press Enter to continue (Ctrl+C to abort)... ", () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const { book, issue, fromStep, dryRun, auto } = parseArgs();

  console.log(`\n📚 Comic Ingest Pipeline`);
  console.log(`   Book:  ${book}`);
  console.log(`   Issue: ${issue}`);
  if (dryRun) console.log(`   Mode:  DRY RUN`);
  console.log();

  // Pre-flight: check if pages exist; if not, prompt to run scrape-pages first
  if (!dryRun && !(await checkPagesExist(book, issue))) {
    console.log(`⚠️  No page images found for ${book}/${issue}.`);
    console.log(
      `   Run this first to download pages:\n\n   pnpm scrape-pages -- --book ${book} --issue ${issue}\n`,
    );
    process.exit(1);
  }

  const checkpoint = await readCheckpoint(book, issue);

  // --from-step: clear completed steps from that step onward
  if (fromStep) {
    const stepIndex = PIPELINE_STEPS.findIndex((s) => s.id === fromStep);
    if (stepIndex === -1) {
      console.error(
        `❌ Unknown step: "${fromStep}". Valid steps:\n${PIPELINE_STEPS.map((s) => `  ${s.id}`).join("\n")}`,
      );
      process.exit(1);
    }
    const stepsToKeep = PIPELINE_STEPS.slice(0, stepIndex).map((s) => s.id);
    checkpoint.completedSteps = checkpoint.completedSteps.filter((s) =>
      stepsToKeep.includes(s),
    );
    console.log(`🔄 Restarting from step: ${fromStep}\n`);
  }

  const alreadyDone = checkpoint.completedSteps.length;
  if (alreadyDone > 0) {
    console.log(
      `📋 Resuming — ${alreadyDone} step(s) already complete: ${checkpoint.completedSteps.join(", ")}\n`,
    );
  }

  let ranAny = false;

  for (const step of PIPELINE_STEPS) {
    if (checkpoint.completedSteps.includes(step.id)) {
      console.log(`⏭️  [skip]  ${step.id}`);
      continue;
    }

    if (dryRun) {
      console.log(
        `🔍 [would run]  ${step.id}${step.humanPause ? " [human pause]" : ""}`,
      );
      continue;
    }

    console.log(`\n▶  Running: ${step.id}`);
    console.log("─".repeat(60));

    if (step.humanPause && step.pauseMessage) {
      await promptContinue(step.pauseMessage);
    }

    checkpoint.currentStep = step.id;
    checkpoint.failedStep = null;
    await writeCheckpoint(checkpoint);

    try {
      if (step.id === "validate-inputs") {
        await validateInputs(book, issue);
      } else {
        // Check if the pnpm script exists
        const pkg = (await fs.readJson(join(PROJECT_ROOT, "package.json"))) as {
          scripts: Record<string, string>;
        };
        if (!pkg.scripts[step.id]) {
          console.log(
            `   ⚠️  No script named "${step.id}" in package.json — skipping`,
          );
        } else {
          const extraArgs: string[] = [];
          if (auto) extraArgs.push("--auto");
          if (
            (step.id === "review-new-characters" ||
              step.id === "review-speakers") &&
            process.env.STORAGE_MODE === "supabase"
          ) {
            extraArgs.push("--db");
          }
          const exitCode = await runPnpmScript(step.id, book, issue, extraArgs);

          if (
            (step.id === "review-new-characters" ||
              step.id === "review-speakers") &&
            exitCode === 2
          ) {
            console.log(
              `\n⏸️  Pipeline paused at ${step.id} — complete the browser review, then re-run ingest.`,
            );
            checkpoint.currentStep = null;
            checkpoint.failedStep = null;
            await writeCheckpoint(checkpoint);
            process.exit(0);
          }

          if (exitCode !== 0) {
            throw new Error(`Script "${step.id}" exited with code ${exitCode}`);
          }
        }
      }

      checkpoint.completedSteps.push(step.id);
      checkpoint.currentStep = null;
      checkpoint.lastCompletedAt = new Date().toISOString();
      await writeCheckpoint(checkpoint);

      console.log(`\n✅ Completed: ${step.id}`);
      ranAny = true;
    } catch (err) {
      checkpoint.failedStep = step.id;
      checkpoint.currentStep = null;
      await writeCheckpoint(checkpoint);

      console.error(
        `\n❌ Failed at step: ${step.id}`,
        err instanceof Error ? err.message : err,
      );
      console.error(
        `\nCheckpoint saved. Re-run to resume from this step, or use --from-step ${step.id} to retry.`,
      );
      process.exit(1);
    }
  }

  if (dryRun) {
    console.log("\n🔍 Dry run complete — no steps were executed.");
    return;
  }

  if (!ranAny) {
    console.log("\n✅ All steps already complete — nothing to do.");
  } else {
    console.log("\n🎉 Pipeline complete!");
  }

  console.log(`   Book:  ${book}`);
  console.log(`   Issue: ${issue}`);
  console.log(
    `   Steps: ${checkpoint.completedSteps.length}/${PIPELINE_STEPS.length} complete\n`,
  );
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
