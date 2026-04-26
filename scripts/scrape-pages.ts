#!/usr/bin/env node

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as readline from "readline";
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import https from "https";
import http from "http";
import { GEMINI_MEDIUM } from "./utils/models.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

function parseArgs(): { url?: string; book: string; issue: string } {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: pnpm scrape-pages -- --url <url> --book <name> --issue <n>

Options:
  --url=URL, --url URL         Comic page URL to scrape (prompted if omitted)
  --book=NAME, --book NAME     Book name (required)
  --issue=N, --issue N         Issue number (required)
  --help, -h                   Show this help message

Examples:
  pnpm scrape-pages -- --url "https://..." --book tmnt-mmpr --issue 4
  pnpm scrape-pages -- --book tmnt-mmpr --issue 4   # prompts for URL
`);
    process.exit(0);
  }

  let url: string | undefined;
  let book = "";
  let issue = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith("--url="))
      url = arg.split("=").slice(1).join("=").trim();
    if (arg === "--url") url = args[i + 1]?.trim();
    if (arg.startsWith("--book=")) book = arg.split("=")[1]?.trim() ?? "";
    if (arg === "--book") book = args[i + 1]?.trim() ?? "";
    if (arg.startsWith("--issue=")) {
      const n = arg.split("=")[1]?.trim() ?? "";
      issue = n.startsWith("issue-") ? n : `issue-${n}`;
    }
    if (arg === "--issue") {
      const n = args[i + 1]?.trim() ?? "";
      issue = n.startsWith("issue-") ? n : `issue-${n}`;
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

  return { url, book, issue };
}

async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptConfirm(question: string): Promise<boolean> {
  const answer = await promptLine(question);
  return answer === "" || answer.toLowerCase().startsWith("y");
}

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);

    const request = protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.remove(destPath).then(() => {
          downloadFile(response.headers.location!, destPath)
            .then(resolve)
            .catch(reject);
        });
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.remove(destPath).then(() => {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        });
        return;
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    });

    request.on("error", (err) => {
      file.close();
      fs.remove(destPath).then(() => reject(err));
    });
  });
}

function extFromUrl(url: string): string {
  const clean = url.split("?")[0] ?? url;
  const match = clean.match(/\.(jpe?g|png|webp|gif)$/i);
  return match ? match[1]!.toLowerCase().replace("jpeg", "jpg") : "jpg";
}

async function main() {
  const { url: argUrl, book, issue } = parseArgs();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY environment variable is not set");
    process.exit(1);
  }

  let url = argUrl;
  if (!url) {
    url = await promptLine("Enter the comic URL to scrape: ");
    if (!url) {
      console.error("❌ URL is required");
      process.exit(1);
    }
  }

  const pagesDir = join(PROJECT_ROOT, "assets", "comics", book, issue, "pages");
  await fs.ensureDir(pagesDir);

  console.log(`\n📖 Scraping comic pages`);
  console.log(`   Book:  ${book}`);
  console.log(`   Issue: ${issue}`);
  console.log(`   URL:   ${url}`);
  console.log(`   Model: google/${GEMINI_MEDIUM}`);
  console.log();

  const stagehand = new Stagehand({
    env: "LOCAL",
    model: {
      modelName: `google/${GEMINI_MEDIUM}`,
      apiKey,
    },
    verbose: 0,
    disablePino: true,
    logger: () => {},
  });

  const pageSchema = z.object({
    pages: z
      .array(
        z.object({
          url: z.string().url().describe("Full URL of the comic page image"),
          pageNumber: z
            .number()
            .optional()
            .describe(
              "Page number if visible in the image or surrounding context",
            ),
        }),
      )
      .describe("All comic book page images found on this page"),
  });

  let collectedUrls: string[] = [];

  try {
    console.log("🌐 Launching browser...");
    await stagehand.init();

    const page = stagehand.context.pages()[0];
    if (!page) throw new Error("No active browser page found after init");

    console.log("🔍 Navigating to URL...");
    await page.goto(url, { waitUntil: "load" });

    let paginationAttempts = 0;
    const MAX_PAGINATION = 50;
    const seenUrls = new Set<string>();

    while (paginationAttempts <= MAX_PAGINATION) {
      console.log(
        `   Extracting page images${paginationAttempts > 0 ? ` (page ${paginationAttempts + 1})` : ""}...`,
      );

      const result = await stagehand.extract(
        "Extract all comic book page image URLs from this page. Include only the full-size page images, not thumbnails, icons, ads, navigation buttons, or UI elements.",
        pageSchema,
      );

      let newFound = 0;
      for (const p of result.pages) {
        if (!seenUrls.has(p.url)) {
          seenUrls.add(p.url);
          collectedUrls.push(p.url);
          newFound++;
        }
      }

      console.log(
        `   Found ${newFound} new image(s) (${collectedUrls.length} total)`,
      );

      // Only try pagination if we found very few images on this page
      if (result.pages.length >= 3) break;

      // Check if there's a next page
      const observed = await stagehand.observe(
        "Is there a next page button, next arrow, or pagination control to navigate to more comic pages?",
      );
      if (!observed || observed.length === 0) break;

      console.log("   Navigating to next page...");
      await stagehand.act(
        "click the next page button or arrow to go to the next comic page",
      );
      await page.waitForLoadState("load");
      paginationAttempts++;
    }
  } finally {
    await stagehand.close();
  }

  if (collectedUrls.length === 0) {
    console.log(`
⚠️  Could not auto-detect pages. The site may use canvas rendering or DRM.
   You can provide image URLs manually via: pnpm download-comic-images
`);
    process.exit(0);
  }

  // Show table
  console.log(`\n📋 Found ${collectedUrls.length} page(s):\n`);
  const maxShow = Math.min(collectedUrls.length, 5);
  for (let i = 0; i < maxShow; i++) {
    const n = String(i + 1).padStart(2);
    const u = collectedUrls[i]!;
    const truncated = u.length > 80 ? `${u.slice(0, 77)}...` : u;
    console.log(`   ${n}. ${truncated}`);
  }
  if (collectedUrls.length > 5) {
    console.log(`   ... and ${collectedUrls.length - 5} more`);
  }

  const confirmed = await promptConfirm(
    `\nDownload ${collectedUrls.length} pages to ${pagesDir}? [Y/n] `,
  );
  if (!confirmed) {
    console.log("Aborted.");
    process.exit(0);
  }

  console.log("\n⬇️  Downloading pages...\n");
  let downloaded = 0;
  for (let i = 0; i < collectedUrls.length; i++) {
    const imgUrl = collectedUrls[i]!;
    const num = String(i + 1).padStart(2, "0");
    const ext = extFromUrl(imgUrl);
    const filename = `page-${num}.${ext}`;
    const destPath = join(pagesDir, filename);

    process.stdout.write(`   Downloading page-${num}.${ext}... `);
    try {
      await downloadFile(imgUrl, destPath);
      process.stdout.write("✓\n");
      downloaded++;
    } catch (err) {
      process.stdout.write(`✗ (${err instanceof Error ? err.message : err})\n`);
    }
  }

  const first = `page-01.${extFromUrl(collectedUrls[0]!)}`;
  const last = `page-${String(downloaded).padStart(2, "0")}.${extFromUrl(collectedUrls[downloaded - 1]!)}`;

  console.log(`\n✅ Downloaded ${downloaded}/${collectedUrls.length} pages`);
  console.log(`   ${first} → ${last}`);
  console.log(`   Output: ${pagesDir}\n`);
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
