import "server-only";
import { z } from "zod";
import { GEMINI_MEDIUM } from "~/lib/models";
import {
  extractPageImageUrls,
  fetchHtml,
  isSameIssuePage,
  MIN_PAGE_IMAGES,
  siteNameFrom,
} from "~/lib/add-content/page-images";
import {
  assertPublicHttpUrl,
  isPublicHttpUrl,
} from "~/lib/add-content/public-url";

/**
 * The page images of one confirmed issue URL (#792). The Check step and the
 * downloader both call this, so the count Doug confirms is the list the
 * downloader stores.
 *
 * A plain fetch first. When it is blocked (batcave.biz answers 403) or finds
 * fewer than MIN_PAGE_IMAGES images, a Browserbase session reads the same URL.
 * That session never leaves the issue: popups and new tabs are closed, a
 * navigation off the confirmed path goes back, and pagination is followed only
 * within the issue's own path (`isSameIssuePage`).
 */
export interface CollectedPages {
  imageUrls: string[];
  siteName: string;
  via: "fetch" | "browser";
  /** The page title the browser ended on, to explain a short count. */
  pageTitle: string | null;
}

/** Cap on pages the browser path visits within one issue's own pagination. */
const MAX_ISSUE_PAGES = 60;

export async function collectPageImages(
  url: string,
  onStatus: (message: string) => void = () => undefined,
): Promise<CollectedPages> {
  assertPublicHttpUrl(url);
  let html: string | null = null;
  let imageUrls: string[] = [];
  try {
    const fetched = await fetchHtml(url);
    if (new URL(fetched.finalUrl).origin !== new URL(url).origin) {
      // Another site answers for this URL: no browser session on a dead end.
      return {
        imageUrls: [],
        siteName: siteNameFrom(null, url),
        via: "fetch",
        pageTitle: `This URL moves to ${fetched.finalUrl}; check that URL instead`,
      };
    }
    if (isSameIssuePage(fetched.finalUrl, url)) {
      html = fetched.html;
      imageUrls = publicOnly(
        extractPageImageUrls(html, fetched.finalUrl),
        onStatus,
      );
    } else {
      onStatus(
        `Plain fetch landed on ${fetched.finalUrl}, not the confirmed issue; using the browser.`,
      );
    }
  } catch (err) {
    onStatus(
      `Plain fetch failed (${err instanceof Error ? err.message : "unknown"}); using the browser.`,
    );
  }
  if (imageUrls.length >= MIN_PAGE_IMAGES) {
    return {
      imageUrls,
      siteName: siteNameFrom(html, url),
      via: "fetch",
      pageTitle: null,
    };
  }
  if (html) {
    onStatus(
      `Plain fetch found ${imageUrls.length} page image(s); using the browser.`,
    );
  }
  const browser = await collectWithBrowser(url, onStatus);
  return {
    imageUrls: publicOnly(browser.imageUrls, onStatus),
    siteName: siteNameFrom(browser.headHtml, url),
    via: "browser",
    pageTitle: browser.pageTitle,
  };
}

/**
 * Drops image URLs the server must not fetch. The downloader fetches only
 * what this returns, and re-checks where each image fetch lands.
 */
function publicOnly(urls: string[], onStatus: (m: string) => void): string[] {
  const kept = urls.filter(isPublicHttpUrl);
  if (kept.length < urls.length) {
    onStatus(`Dropped ${urls.length - kept.length} non-public image URL(s).`);
  }
  return kept;
}

/** A page's identity for the visited set: the URL without its hash. */
function pageKey(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return u.href;
}

const pageSchema = z.object({
  pages: z
    .array(
      z.object({
        url: z.string().url().describe("Full URL of the comic page image"),
        pageNumber: z.number().optional().describe("Page number if visible"),
      }),
    )
    .describe("All comic book page images found on this page"),
});

const EXTRACT_INSTRUCTION =
  "Extract all comic book page image URLs from this page. Include only the full-size page images, not thumbnails, icons, ads, navigation buttons, or UI elements.";

async function collectWithBrowser(
  sourceUrl: string,
  onStatus: (message: string) => void,
): Promise<{
  imageUrls: string[];
  headHtml: string | null;
  pageTitle: string | null;
}> {
  const geminiKey = process.env.GEMINI_API_KEY;
  const bbApiKey = process.env.BROWSERBASE_API_KEY;
  const bbProjectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!geminiKey || !bbApiKey || !bbProjectId) {
    throw new Error(
      "Missing GEMINI_API_KEY, BROWSERBASE_API_KEY, or BROWSERBASE_PROJECT_ID",
    );
  }

  onStatus("Launching browser via Browserbase...");
  const { Stagehand } = await import("@browserbasehq/stagehand");
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: bbApiKey,
    projectId: bbProjectId,
    model: { modelName: `google/${GEMINI_MEDIUM}`, apiKey: geminiKey },
    verbose: 0,
    disablePino: true,
    logger: () => undefined,
  });

  const collected: string[] = [];
  let headHtml: string | null = null;
  let pageTitle: string | null = null;
  try {
    await stagehand.init();
    const context = stagehand.context;
    // Ad scripts open tabs through window.open; this stops most of them.
    await context.addInitScript(() => {
      window.open = () => null;
    });
    const page = context.pages()[0];
    if (!page) throw new Error("No browser page after init");

    /** Close every tab but ours (ads open them on click) and focus ours. */
    const closeStrays = async () => {
      for (const p of context.pages()) {
        if (p.targetId() !== page.targetId()) {
          await p.close().catch(() => undefined);
        }
      }
      context.setActivePage(page);
    };
    /** True when our tab is still on the issue; one way back if it is not. */
    const onIssue = async (backTo: string) => {
      await closeStrays();
      if (isSameIssuePage(page.url(), sourceUrl)) return true;
      onStatus(`Left the issue (now at ${page.url()}); going back.`);
      await page.goto(backTo, { waitUntil: "load" });
      await closeStrays();
      return isSameIssuePage(page.url(), sourceUrl);
    };
    /** New images from our tab; none if the tab left the issue around it. */
    const extract = async () => {
      await scrollToLoadImages(page);
      if (!(await onIssue(sourceUrl))) return 0;
      const result = await stagehand.extract(EXTRACT_INSTRUCTION, pageSchema, {
        page,
      });
      if (!isSameIssuePage(page.url(), sourceUrl)) {
        onStatus(`Left the issue during extraction (now at ${page.url()}).`);
        return 0;
      }
      const before = collected.length;
      for (const p of result.pages) {
        if (!collected.includes(p.url)) collected.push(p.url);
      }
      onStatus(`Found ${collected.length} page image(s)...`);
      return collected.length - before;
    };

    onStatus("Navigating to source URL...");
    await page.goto(sourceUrl, { waitUntil: "load" });
    if (!(await onIssue(sourceUrl)))
      return { imageUrls: [], headHtml, pageTitle };
    headHtml = await page.evaluate(() => document.head.outerHTML);
    pageTitle = await page.evaluate(() => document.title);

    // "All pages" reading mode, where the reader has a select for it.
    const modeSet = await page.evaluate(() => {
      const sel = document.querySelector<HTMLSelectElement>("#selectReadType");
      if (!sel) return false;
      sel.value = "1";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
    if (modeSet) {
      onStatus("Set reading mode to All Pages");
      await new Promise((r) => setTimeout(r, 1500));
    }

    let found = await extract();
    if (found < MIN_PAGE_IMAGES && !modeSet) {
      // One try at the reader's own all-pages switch (batcave.biz: Settings,
      // top right of the reader bar, infinite scroll).
      onStatus("Turning on the reader's infinite scroll...");
      await stagehand
        .act(
          "Open the comic reader's settings menu (top right of the reader bar) and turn on infinite scroll so every page shows on one scroll. Do not click ads or links.",
          { page },
        )
        .catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1500));
      found += await extract();
    }

    // Pagination: only this issue's own pages (`?page=2`, `/2/`), never a
    // next-issue or other-site link.
    const visited = new Set([pageKey(page.url())]);
    while (found < MIN_PAGE_IMAGES && visited.size < MAX_ISSUE_PAGES) {
      const hrefs = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLAnchorElement>("a[href]"),
          (a) => a.href,
        ),
      );
      const next = hrefs.find(
        (h) => isSameIssuePage(h, sourceUrl) && !visited.has(pageKey(h)),
      );
      if (!next) break;
      visited.add(pageKey(next));
      onStatus(`Opening ${next} (same issue)...`);
      await page.goto(next, { waitUntil: "load" });
      if (!(await onIssue(next))) break;
      found = await extract();
    }
    pageTitle = await page.evaluate(() => document.title);
  } finally {
    try {
      await stagehand.close();
    } catch (closeErr) {
      console.error("collectPageImages: stagehand.close() failed:", closeErr);
    }
  }
  return { imageUrls: collected, headHtml, pageTitle };
}

interface ScrollablePage {
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
}

async function scrollToLoadImages(page: ScrollablePage): Promise<void> {
  const scrollStep = 900;
  const MAX_ITERATIONS = 150;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    await page.evaluate((step: number) => window.scrollBy(0, step), scrollStep);
    await new Promise((r) => setTimeout(r, 500));
    iterations++;

    const totalHeight: number = await page.evaluate(
      () => document.body.scrollHeight,
    );
    const scrollY: number = await page.evaluate(
      () => window.scrollY + window.innerHeight,
    );

    if (scrollY >= totalHeight) {
      await new Promise((r) => setTimeout(r, 1500));
      const newHeight: number = await page.evaluate(
        () => document.body.scrollHeight,
      );
      if (newHeight === totalHeight) break;
    }
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 500));
}
