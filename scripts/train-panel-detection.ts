#!/usr/bin/env node

/**
 * Sends comic page WebPs through your Roboflow panel-detection workflow
 * to feed it more training data via Roboflow's auto-labeling. Doesn't
 * persist results — Roboflow captures the inference internally for you
 * to label/correct in their dashboard.
 *
 * Workflow URL: ROBOFLOW_PANEL_WORKFLOW_URL in .env (see src/env.mjs), defaulting to
 *   https://serverless.roboflow.com/fresh-space/workflows/find-comic-panel-v1
 *
 * Usage:
 *   pnpm train-panel-detection -- --book tmnt-mmpr-iii --issue 1
 *   pnpm train-panel-detection -- --book tmnt-mmpr-iii            # all issues
 *   pnpm train-panel-detection -- --all                            # every book
 *   pnpm train-panel-detection -- --concurrency 3 --delay-ms 1500  # throttle
 *
 * Pages are read from assets/comics/<book>/issue-<n>/pages-webp when present
 * (preferred), otherwise from pages/ (JPEG/WebP/PNG). Images are resized and
 * sent as WebP base64 to Roboflow.
 */

import { env } from "~/env.mjs";
import fs from "fs-extra";
import path from "path";
import pLimit from "p-limit";
import sharp from "sharp";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, "..");
const ASSETS_COMICS = path.join(PROJECT_ROOT, "assets", "comics");

/** Matches Roboflow workflow snippet `inputs.confidence` (tunable via env if we add it later). */
const PANEL_WORKFLOW_CONFIDENCE = 0.4;

/** Downscale huge comic scans so the hosted workflow stays under payload/runtime limits. */
const MAX_IMAGE_EDGE_PX = 2048;

async function bufferForRoboflowWorkflow(imageBuffer: Buffer): Promise<Buffer> {
  return sharp(imageBuffer)
    .rotate()
    .resize({
      width: MAX_IMAGE_EDGE_PX,
      height: MAX_IMAGE_EDGE_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 90 })
    .toBuffer();
}

interface Args {
  book?: string;
  issue?: string;
  all: boolean;
  concurrency: number;
  delayMs: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let book: string | undefined;
  let issue: string | undefined;
  let all = false;
  let concurrency = 2;
  let delayMs = 1000;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--book":
        book = argv[++i];
        break;
      case "--issue":
        issue = argv[++i];
        if (issue && !issue.startsWith("issue-")) issue = `issue-${issue}`;
        break;
      case "--all":
        all = true;
        break;
      case "--concurrency":
        concurrency = parseInt(argv[++i] ?? "2", 10);
        break;
      case "--delay-ms":
        delayMs = parseInt(argv[++i] ?? "1000", 10);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: pnpm train-panel-detection -- [--book <name>] [--issue <n>] [--all] [--concurrency 2] [--delay-ms 1000] [--dry-run]",
        );
        process.exit(0);
    }
  }

  if (!book && !all) {
    console.error("Provide either --book <name> or --all");
    process.exit(1);
  }
  return { book, issue, all, concurrency, delayMs, dryRun };
}

interface LocalIssue {
  bookId: string;
  issueId: string;
  pagePaths: string[];
}

function pageAssetFolderLabel(pagePaths: string[]): string {
  const first = pagePaths[0];
  if (!first) return "pages";
  return path.basename(path.dirname(first));
}

function pageNumberFromFilename(filename: string): number {
  const m = filename.match(/^page-(\d+)\./i);
  return m?.[1] ? parseInt(m[1], 10) : 0;
}

const PAGE_IMAGE_RE = /^page-\d+\.(jpe?g|webp|png)$/i;
const PAGE_WEBP_RE = /^page-\d+\.webp$/i;

async function listSortedPagePaths(pagesDir: string): Promise<string[]> {
  if (!(await fs.pathExists(pagesDir))) return [];
  const names = await fs.readdir(pagesDir);
  const files = names
    .filter((n) => PAGE_IMAGE_RE.test(n))
    .sort((a, b) => pageNumberFromFilename(a) - pageNumberFromFilename(b));
  return files.map((n) => path.join(pagesDir, n));
}

async function listSortedWebpPagePaths(
  pagesWebpDir: string,
): Promise<string[]> {
  if (!(await fs.pathExists(pagesWebpDir))) return [];
  const names = await fs.readdir(pagesWebpDir);
  const files = names
    .filter((n) => PAGE_WEBP_RE.test(n))
    .sort((a, b) => pageNumberFromFilename(a) - pageNumberFromFilename(b));
  return files.map((n) => path.join(pagesWebpDir, n));
}

/** Prefer pipeline WebPs in pages-webp/; fall back to raw pages/ when missing. */
async function resolveIssuePagePaths(
  bookDir: string,
  issueId: string,
): Promise<string[]> {
  const webpPaths = await listSortedWebpPagePaths(
    path.join(bookDir, issueId, "pages-webp"),
  );
  if (webpPaths.length > 0) return webpPaths;
  return listSortedPagePaths(path.join(bookDir, issueId, "pages"));
}

async function listIssuesForBook(
  bookId: string,
  filterIssueFolder?: string,
): Promise<LocalIssue[]> {
  const bookDir = path.join(ASSETS_COMICS, bookId);
  if (!(await fs.pathExists(bookDir))) {
    console.error(`Book directory not found: ${bookDir}`);
    return [];
  }
  const entries = await fs.readdir(bookDir);
  const issueDirs: string[] = [];
  for (const name of entries) {
    if (!name.startsWith("issue-")) continue;
    if (filterIssueFolder && name !== filterIssueFolder) continue;
    const full = path.join(bookDir, name);
    if ((await fs.stat(full)).isDirectory()) issueDirs.push(name);
  }
  issueDirs.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
  const out: LocalIssue[] = [];
  for (const issueId of issueDirs) {
    const pagePaths = await resolveIssuePagePaths(bookDir, issueId);
    if (pagePaths.length === 0) continue;
    out.push({ bookId, issueId, pagePaths });
  }
  return out;
}

async function listAllIssues(): Promise<LocalIssue[]> {
  if (!(await fs.pathExists(ASSETS_COMICS))) {
    console.error(`Comics assets directory not found: ${ASSETS_COMICS}`);
    return [];
  }
  const bookNames = (await fs.readdir(ASSETS_COMICS)).filter(
    (n) => !n.startsWith("."),
  );
  const out: LocalIssue[] = [];
  for (const bookId of bookNames) {
    const bookPath = path.join(ASSETS_COMICS, bookId);
    if (!(await fs.stat(bookPath)).isDirectory()) continue;
    out.push(...(await listIssuesForBook(bookId)));
  }
  out.sort((a, b) => {
    const byBook = a.bookId.localeCompare(b.bookId);
    if (byBook !== 0) return byBook;
    return a.issueId.localeCompare(b.issueId, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
  return out;
}

interface InferResult {
  ok: boolean;
  status: number;
  detections?: number;
  error?: string;
}

async function sendToRoboflow(imageBuffer: Buffer): Promise<InferResult> {
  try {
    const normalized = await bufferForRoboflowWorkflow(imageBuffer);
    const base64Image = normalized.toString("base64");
    const res = await fetch(env.ROBOFLOW_PANEL_WORKFLOW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.ROBOFLOW_API_KEY,
        inputs: {
          image: {
            type: "base64",
            value: base64Image,
          },
          confidence: PANEL_WORKFLOW_CONFIDENCE,
        },
      }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: await res.text() };
    }
    const result = (await res.json()) as Record<string, unknown>;
    // Try to surface a detection count for visibility — workflow output
    // shape varies, so we best-effort.
    let detections: number | undefined;
    const outputs = (result.outputs ?? result) as unknown;
    if (Array.isArray(outputs) && outputs.length > 0) {
      const first = outputs[0] as Record<string, unknown>;
      const preds =
        (first.predictions as Array<unknown> | undefined) ??
        (first.predictions_list as Array<unknown> | undefined);
      if (preds) detections = preds.length;
    }
    return { ok: true, status: res.status, detections };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

async function main() {
  const { book, issue, all, concurrency, delayMs, dryRun } = parseArgs();

  let issues: LocalIssue[] = [];
  if (all) {
    issues = await listAllIssues();
  } else if (book) {
    issues = await listIssuesForBook(book, issue);
  }

  if (issues.length === 0) {
    console.log("No matching issues found.");
    process.exit(0);
  }

  const totalPages = issues.reduce((acc, i) => acc + i.pagePaths.length, 0);
  console.log(
    `Found ${issues.length} issue(s), ${totalPages} pages total. concurrency=${concurrency} delay=${delayMs}ms`,
  );
  console.log(
    `Roboflow workflow: ${env.ROBOFLOW_PANEL_WORKFLOW_URL} (confidence=${PANEL_WORKFLOW_CONFIDENCE}; images max ${MAX_IMAGE_EDGE_PX}px edge)`,
  );
  if (dryRun) {
    for (const i of issues) {
      const src = pageAssetFolderLabel(i.pagePaths);
      console.log(
        `  ${i.bookId}/${i.issueId} → ${i.pagePaths.length} pages (${src})`,
      );
    }
    return;
  }

  const limit = pLimit(concurrency);
  let success = 0;
  let failed = 0;
  let processed = 0;

  for (const iss of issues) {
    console.log(
      `\n📚 ${iss.bookId} / ${iss.issueId} (${pageAssetFolderLabel(iss.pagePaths)})`,
    );
    await Promise.all(
      iss.pagePaths.map((pagePath) =>
        limit(async () => {
          const pageLabel = path.basename(pagePath);
          await new Promise((r) => setTimeout(r, delayMs));
          const imageBuffer = await fs.readFile(pagePath);
          const r = await sendToRoboflow(imageBuffer);
          processed++;
          if (r.ok) {
            success++;
            const n =
              r.detections !== undefined ? `${r.detections} panels` : "ok";
            console.log(`  ✓ [${processed}/${totalPages}] ${pageLabel} → ${n}`);
          } else {
            failed++;
            console.log(
              `  ✗ [${processed}/${totalPages}] ${pageLabel} → ${r.status} ${r.error?.slice(0, 80) ?? "error"}`,
            );
          }
        }),
      ),
    );
  }

  console.log(
    `\n✅ Done. ${success} ok / ${failed} failed across ${processed} pages.`,
  );
  console.log(
    "Roboflow has captured each inference for review/labeling in your project dashboard.",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
