#!/usr/bin/env node

/**
 * Orchestrate the full fixes workflow:
 *   1. apply-fixes           — patch bubbles.json, flag changed bubbles
 *   2. sort-bubbles-gemini   — re-sort reading order on pages that had adds (skipped if none)
 *   3. ocr-flagged-bubbles   — Gemini OCR + textWithCues for empty-text adds
 *   4. generate-audio        — regenerate audio for flagged bubbles only
 *   5. copy-to-public        — stage updated files
 *   6. generate-manifest     — rebuild manifest.json
 *
 * Usage: pnpm orch-fixes -- --book <name> --issue <n> --fixes <path>
 */

import fs from "fs-extra";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

interface FixEntry {
  bubbleId: string;
  action: "update" | "delete" | "add";
  pageIndex?: number;
}
interface FixesJson {
  bookId: string;
  issueId: string;
  fixes: FixEntry[];
}

function parseArgs(): { book: string; issue: string; fixesPath: string } {
  const args = process.argv.slice(2);
  let book = "";
  let issue = "";
  let fixesPath = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--book=")) book = arg.split("=")[1]?.trim() ?? "";
    if (arg === "--book") {
      const n = args[i + 1];
      if (n) book = n.trim();
    }
    if (arg.startsWith("--issue=")) {
      const v = arg.split("=")[1]?.trim() ?? "";
      issue = v.startsWith("issue-") ? v : `issue-${v}`;
    }
    if (arg === "--issue") {
      const n = args[i + 1];
      if (n) issue = n.startsWith("issue-") ? n : `issue-${n}`;
    }
    if (arg.startsWith("--fixes=")) fixesPath = arg.split("=")[1]?.trim() ?? "";
    if (arg === "--fixes") {
      const n = args[i + 1];
      if (n) fixesPath = n.trim();
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
  if (!fixesPath) {
    console.error("❌ --fixes is required");
    process.exit(1);
  }

  return { book, issue, fixesPath };
}

function run(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", [script, "--", ...args], {
      stdio: "inherit",
      env: process.env,
      cwd: PROJECT_ROOT,
    });
    child.on("close", (code) => {
      code === 0
        ? resolve()
        : reject(new Error(`"${script}" exited with code ${code}`));
    });
    child.on("error", (err) =>
      reject(new Error(`Failed to start "${script}": ${err.message}`)),
    );
  });
}

// Extract page numbers from "add" fixes — these need re-sorting
function pagesWithAdds(fixes: FixEntry[]): string[] {
  const pages = new Set<string>();
  for (const fix of fixes) {
    if (fix.action === "add" && fix.pageIndex != null) {
      pages.add(String(fix.pageIndex).padStart(2, "0"));
    }
  }
  return [...pages].sort();
}

async function main() {
  const { book, issue, fixesPath } = parseArgs();
  const SEP = "─".repeat(60);

  const fixesJson = (await fs.readJson(fixesPath)) as FixesJson;
  const addedPages = pagesWithAdds(fixesJson.fixes);

  console.log(`\n${SEP}`);
  console.log(`  Apply fixes — ${book} / ${issue}`);
  console.log(`  Fixes: ${fixesPath}`);
  if (addedPages.length > 0) {
    console.log(`  Pages needing re-sort: ${addedPages.join(", ")}`);
  }
  console.log(SEP);

  type Step = { name: string; script: string; args: string[] };

  const steps: Step[] = [
    {
      name: "apply-fixes",
      script: "apply-fixes",
      args: [`--fixes=${fixesPath}`],
    },
    {
      name: "ocr-flagged-bubbles",
      script: "ocr-flagged-bubbles",
      args: [`--book=${book}`, `--issue=${issue}`],
    },
    // Sort after OCR so added bubbles have text + style coords for Gemini to work with
    ...addedPages.map((page) => ({
      name: `sort-bubbles-gemini (page ${page})`,
      script: "sort-bubbles-gemini",
      args: [`--book=${book}`, `--issue=${issue}`, `--page=${page}`],
    })),
    {
      name: "generate-audio (flagged only)",
      script: "generate-audio",
      args: [`--book=${book}`, `--issue=${issue}`, "--only-flagged"],
    },
    {
      name: "copy-to-public",
      script: "copy-to-public",
      args: [`--book=${book}`, `--issue=${issue}`],
    },
    {
      name: "generate-manifest",
      script: "generate-manifest",
      args: [`--book=${book}`, `--issue=${issue}`],
    },
  ];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    console.log(`\n▶  [${i + 1}/${steps.length}] ${step.name}`);
    console.log(SEP);
    try {
      await run(step.script, step.args);
      console.log(`✅ ${step.name} done`);
    } catch (err) {
      console.error(`\n❌ Failed at: ${step.name}`);
      console.error(`   ${err instanceof Error ? err.message : String(err)}`);
      console.error(
        `\n   Re-run from this step manually, or fix the issue and retry.`,
      );
      process.exit(1);
    }
  }

  console.log(`\n${SEP}`);
  console.log(`  All done. ${steps.length} steps completed.`);
  console.log(SEP);
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
