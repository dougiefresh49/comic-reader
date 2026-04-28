#!/usr/bin/env node

/**
 * Sends comic page WebPs through your Roboflow panel-detection workflow
 * to feed it more training data via Roboflow's auto-labeling. Doesn't
 * persist results — Roboflow captures the inference internally for you
 * to label/correct in their dashboard.
 *
 * Workflow: https://detect.roboflow.com/infer/workflows/fresh-space/find-comic-panel-v1
 *
 * Usage:
 *   pnpm train-panel-detection -- --book tmnt-mmpr-iii --issue 1
 *   pnpm train-panel-detection -- --book tmnt-mmpr-iii            # all issues
 *   pnpm train-panel-detection -- --all                            # every book
 *   pnpm train-panel-detection -- --concurrency 3 --delay-ms 1500  # throttle
 *
 * Pages are read from the public Supabase comic-pages bucket so we don't
 * have to ship local files; Roboflow fetches the URL.
 */

import fs from "fs-extra";
import path from "path";
import pLimit from "p-limit";
import { fileURLToPath } from "url";
import { supabase } from "./lib/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, "..");

const ROBOFLOW_WORKFLOW_URL =
  "https://detect.roboflow.com/infer/workflows/fresh-space/find-comic-panel-v1";

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

async function listIssuesForBook(
  bookId: string,
  filterIssueId?: string,
): Promise<Array<{ bookId: string; issueId: string; pageCount: number }>> {
  let query = supabase
    .from("issues")
    .select("id, book_id, page_count")
    .eq("book_id", bookId);
  if (filterIssueId) query = query.eq("id", filterIssueId);
  const { data, error } = await query;
  if (error) {
    console.error("Failed to list issues:", error.message);
    return [];
  }
  return (
    (data ?? []) as Array<{ id: string; book_id: string; page_count: number }>
  ).map((r) => ({ bookId: r.book_id, issueId: r.id, pageCount: r.page_count }));
}

async function listAllIssues(): Promise<
  Array<{ bookId: string; issueId: string; pageCount: number }>
> {
  const { data, error } = await supabase
    .from("issues")
    .select("id, book_id, page_count")
    .order("book_id")
    .order("number");
  if (error) {
    console.error("Failed to list issues:", error.message);
    return [];
  }
  return (
    (data ?? []) as Array<{ id: string; book_id: string; page_count: number }>
  ).map((r) => ({ bookId: r.book_id, issueId: r.id, pageCount: r.page_count }));
}

function pageImageUrl(
  bookId: string,
  issueId: string,
  pageNum: number,
): string {
  const padded = String(pageNum).padStart(2, "0");
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("NEXT_PUBLIC_SUPABASE_URL not set");
  return `${base}/storage/v1/object/public/comic-pages/${bookId}/${issueId}/page-${padded}.webp`;
}

interface InferResult {
  ok: boolean;
  status: number;
  detections?: number;
  error?: string;
}

async function sendToRoboflow(imageUrl: string): Promise<InferResult> {
  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 0, error: "ROBOFLOW_API_KEY not set" };
  }
  try {
    const res = await fetch(ROBOFLOW_WORKFLOW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        inputs: { image: { type: "url", value: imageUrl } },
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

  let issues: Array<{ bookId: string; issueId: string; pageCount: number }> =
    [];
  if (all) {
    issues = await listAllIssues();
  } else if (book) {
    issues = await listIssuesForBook(book, issue);
  }

  if (issues.length === 0) {
    console.log("No matching issues found.");
    process.exit(0);
  }

  const totalPages = issues.reduce((acc, i) => acc + i.pageCount, 0);
  console.log(
    `Found ${issues.length} issue(s), ~${totalPages} pages total. concurrency=${concurrency} delay=${delayMs}ms`,
  );
  if (dryRun) {
    for (const i of issues) {
      console.log(`  ${i.bookId}/${i.issueId} → ${i.pageCount} pages`);
    }
    return;
  }

  const limit = pLimit(concurrency);
  let success = 0;
  let failed = 0;
  let processed = 0;

  for (const iss of issues) {
    console.log(`\n📚 ${iss.bookId} / ${iss.issueId}`);
    await Promise.all(
      Array.from({ length: iss.pageCount }, (_, idx) => idx + 1).map(
        (pageNum) =>
          limit(async () => {
            const url = pageImageUrl(iss.bookId, iss.issueId, pageNum);
            await new Promise((r) => setTimeout(r, delayMs));
            const r = await sendToRoboflow(url);
            processed++;
            if (r.ok) {
              success++;
              const n =
                r.detections !== undefined ? `${r.detections} panels` : "ok";
              console.log(
                `  ✓ [${processed}/${totalPages}] page-${String(pageNum).padStart(2, "0")} → ${n}`,
              );
            } else {
              failed++;
              console.log(
                `  ✗ [${processed}/${totalPages}] page-${String(pageNum).padStart(2, "0")} → ${r.status} ${r.error?.slice(0, 80) ?? "error"}`,
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
