#!/usr/bin/env node

/**
 * Pipeline step: roboflow-page-analyze
 *
 * Calls the v2 SAM3 workflow per page and persists raw output as sidecar
 * JSON under data/sam3/page-NN.json. Downstream step `extract-foreground-masks`
 * consumes these sidecars to populate panels.foreground_polygons.
 *
 * Resumable: skips pages that already have a sidecar unless --overwrite.
 *
 * Usage:
 *   pnpm roboflow-page-analyze -- --book tmnt-mmpr-iii --issue 1
 *   pnpm roboflow-page-analyze -- --book ... --issue ... --overwrite
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";
import { analyzeIssuePages } from "./utils/roboflow-sam3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

interface Args {
  book: string;
  issue: string;
  overwrite: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
Usage: pnpm roboflow-page-analyze -- --book <name> --issue <n> [options]

Options:
  --book NAME, --book=NAME       Book ID (or COMIC_BOOK env var)
  --issue N, --issue=N           Issue number (or COMIC_ISSUE env var)
  --overwrite                    Re-analyze pages that already have sidecars
  --help, -h                     Show this help
`);
    process.exit(0);
  }

  let book = process.env.COMIC_BOOK ?? "";
  let issue = process.env.COMIC_ISSUE ?? "";
  let overwrite = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith("--book=")) book = arg.split("=")[1]?.trim() ?? book;
    else if (arg === "--book") book = argv[i + 1]?.trim() ?? book;
    else if (arg.startsWith("--issue=")) {
      const v = arg.split("=")[1]?.trim() ?? "";
      issue = v.startsWith("issue-") ? v : `issue-${v}`;
    } else if (arg === "--issue") {
      const v = argv[i + 1]?.trim() ?? "";
      issue = v.startsWith("issue-") ? v : `issue-${v}`;
    } else if (arg === "--overwrite") overwrite = true;
  }

  if (!book || !issue) {
    console.error(
      "❌ --book and --issue are required (or set COMIC_BOOK / COMIC_ISSUE)",
    );
    process.exit(1);
  }
  return { book, issue, overwrite };
}

async function discoverPageNumbers(issueDir: string): Promise<number[]> {
  const pagesWebpDir = join(issueDir, "pages-webp");
  const files = await glob("page-*.webp", { cwd: pagesWebpDir });
  const numbers = files
    .map((f) => {
      const m = /page-(\d+)\.webp$/.exec(f);
      return m && m[1] ? parseInt(m[1], 10) : null;
    })
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  return numbers;
}

async function main() {
  const { book, issue, overwrite } = parseArgs();
  const ISSUE_DIR = join(PROJECT_ROOT, "assets", "comics", book, issue);
  const SAM3_DIR = join(ISSUE_DIR, "data", "sam3");

  if (!(await fs.pathExists(ISSUE_DIR))) {
    console.error(`❌ Issue dir not found: ${ISSUE_DIR}`);
    process.exit(1);
  }

  const pageNumbers = await discoverPageNumbers(ISSUE_DIR);
  if (pageNumbers.length === 0) {
    console.error(
      `❌ No page-*.webp files found in ${ISSUE_DIR}/pages-webp — run convert-pages-to-webp first.`,
    );
    process.exit(1);
  }

  await fs.ensureDir(SAM3_DIR);

  // Skip pages that already have a sidecar (unless --overwrite).
  const pagesToProcess: number[] = [];
  for (const n of pageNumbers) {
    const padded = String(n).padStart(2, "0");
    const sidecar = join(SAM3_DIR, `page-${padded}.json`);
    if (!overwrite && (await fs.pathExists(sidecar))) {
      console.log(`   ⏭  page-${padded} already analyzed — skipping`);
      continue;
    }
    pagesToProcess.push(n);
  }

  if (pagesToProcess.length === 0) {
    console.log(
      `\n✅ All ${pageNumbers.length} pages already analyzed. Use --overwrite to re-run.\n`,
    );
    return;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    console.error(
      "❌ NEXT_PUBLIC_SUPABASE_URL not set — Roboflow needs a public URL to fetch pages.",
    );
    process.exit(1);
  }
  const pageUrl = (n: number) => {
    const padded = String(n).padStart(2, "0");
    return `${supabaseUrl}/storage/v1/object/public/comic-pages/${book}/${issue}/page-${padded}.webp`;
  };

  console.log(
    `\n🔎 Roboflow page analyze (panel + bubble + SAM3): ${pagesToProcess.length} page(s) for ${book}/${issue}\n`,
  );

  const results = await analyzeIssuePages({
    pageNumbers: pagesToProcess,
    pageUrl,
    concurrency: 2,
    delayMs: 750,
    onPage: (pageNumber, result) => {
      const padded = String(pageNumber).padStart(2, "0");
      if (!result) {
        console.log(`   ❌ page-${padded} failed`);
        return;
      }
      const segByClass = result.segmentation_predictions.reduce<
        Record<string, number>
      >((acc, p) => {
        acc[p.class] = (acc[p.class] ?? 0) + 1;
        return acc;
      }, {});
      const segSummary = Object.entries(segByClass)
        .map(([cls, n]) => `${cls.replace(/comic /, "")}=${n}`)
        .join(" ");
      console.log(
        `   ✓ page-${padded} → ${result.panel_predictions.length} panels, ${result.bubble_predictions.length} bubbles, seg(${segSummary || "none"})`,
      );
    },
  });

  // Persist sidecars
  for (const { pageNumber, result } of results) {
    const padded = String(pageNumber).padStart(2, "0");
    const sidecar = join(SAM3_DIR, `page-${padded}.json`);
    await fs.writeJSON(sidecar, result, { spaces: 2 });
  }

  const failed = pagesToProcess.length - results.length;
  console.log(
    `\n✅ Complete. Wrote ${results.length} sidecar(s) → ${SAM3_DIR}${failed > 0 ? ` (${failed} failed)` : ""}\n`,
  );
}

main().catch((err) => {
  console.error("❌ roboflow-page-analyze:", err);
  process.exit(1);
});
