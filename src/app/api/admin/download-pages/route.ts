import "server-only";
import { type NextRequest } from "next/server";
import pLimit from "p-limit";
import { z } from "zod";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { storePageImage } from "~/lib/page-images";
import { GEMINI_MEDIUM } from "~/lib/models";
import { selectIssue, updateIssue } from "~/lib/issue-queries";
import {
  fetchPageImageUrls,
  isSameIssuePage,
  MIN_PAGE_IMAGES,
} from "~/lib/add-content/page-images";

const RAW_BUCKET = "comic-pages-raw";

interface ProgressEvent {
  type: "status" | "page" | "done" | "error";
  message: string;
  current?: number;
  total?: number;
}

/** "; watermark left: <reason>" when the clean left one, else "" (#541). */
function watermarkLeft(failures: Array<{ reason: string }>): string {
  if (failures.length === 0) return "";
  return `; watermark left: ${failures.map((f) => f.reason).join(", ")}`;
}

function encodeEvent(event: ProgressEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const bodySchema = z.object({
  bookId: z.string().min(1),
  issueId: z.string().min(1),
  /** The page count Doug confirmed on the Check step. */
  expectedCount: z.number().int().positive(),
});

/** Cap on pages the browser path visits within one issue's own pagination. */
const MAX_ISSUE_PAGES = 60;

/**
 * Stores the pages of the issue's confirmed `source_url`, read from the
 * `issues` row; the client sends no URL (#792). The image list comes from a
 * plain fetch first; the browser runs only when that finds too few. Nothing is
 * stored unless the list matches the count Doug confirmed.
 */
export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "expected { bookId, issueId, expectedCount }" },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const { data: issue, error: issueReadErr } = (await selectIssue(
    supabaseAdmin,
    body.bookId,
    body.issueId,
    "source_url",
  ).maybeSingle()) as {
    data: { source_url: string | null } | null;
    error: { message: string } | null;
  };
  if (issueReadErr) {
    return Response.json({ error: issueReadErr.message }, { status: 500 });
  }
  if (!issue?.source_url) {
    return Response.json(
      { error: `${body.bookId}/${body.issueId} has no confirmed source URL` },
      { status: 404 },
    );
  }
  const sourceUrl = issue.source_url;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ProgressEvent) => {
        controller.enqueue(new TextEncoder().encode(encodeEvent(event)));
      };

      try {
        send({ type: "status", message: `Reading ${sourceUrl}...` });
        let collectedUrls: string[] = [];
        try {
          collectedUrls = await fetchPageImageUrls(sourceUrl);
        } catch (err) {
          send({
            type: "status",
            message: `Plain fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
          });
        }

        if (collectedUrls.length < MIN_PAGE_IMAGES) {
          collectedUrls = await collectWithBrowser(sourceUrl, send);
          if (collectedUrls.length < MIN_PAGE_IMAGES) {
            send({
              type: "error",
              message: `Found ${collectedUrls.length} page image(s) on the confirmed issue and stopped. Nothing was stored.`,
            });
            return;
          }
        }

        if (collectedUrls.length !== body.expectedCount) {
          send({
            type: "error",
            message: `Found ${collectedUrls.length} page images, but ${body.expectedCount} were confirmed. Nothing was stored; check the source again.`,
          });
          return;
        }

        send({
          type: "status",
          message: `Uploading ${collectedUrls.length} pages (raw + WebP) to storage...`,
          total: collectedUrls.length,
        });

        let uploaded = 0;
        // Pages finish out of order under the pool; `current` counts finished pages.
        let finished = 0;
        // Each page now costs a Gemini detect call (#541): three at a time.
        const limit = pLimit(3);

        const storeOne = async (imgUrl: string, i: number) => {
          const num = String(i + 1).padStart(2, "0");
          const pageNumber = i + 1;
          const ext = extFromUrl(imgUrl);
          const rawFilename = `page-${num}.${ext}`;
          const rawPath = `${body.bookId}/${body.issueId}/source/${rawFilename}`;

          try {
            const imgResponse = await fetch(imgUrl);
            if (!imgResponse.ok) {
              send({
                type: "page",
                message: `Failed to download page ${num}: HTTP ${imgResponse.status}`,
                current: ++finished,
                total: collectedUrls.length,
              });
              return;
            }

            const buffer = Buffer.from(await imgResponse.arrayBuffer());
            const contentType =
              imgResponse.headers.get("content-type") ??
              `image/${ext === "jpg" ? "jpeg" : ext}`;

            const rawResult = await supabaseAdmin.storage
              .from(RAW_BUCKET)
              .upload(rawPath, buffer, { contentType, upsert: true });

            if (rawResult.error) {
              send({
                type: "page",
                message: `Raw upload failed for page ${num}: ${rawResult.error.message}`,
                current: ++finished,
                total: collectedUrls.length,
              });
              return;
            }

            try {
              const { width, height, failures } = await storePageImage({
                bookId: body.bookId,
                issueId: body.issueId,
                pageNumber,
                buffer,
              });
              uploaded++;
              send({
                type: "page",
                message: `Uploaded page ${num} (${width}×${height})${watermarkLeft(failures)}`,
                current: ++finished,
                total: collectedUrls.length,
              });
            } catch (err) {
              send({
                type: "page",
                message: `WebP/pages failed for page ${num}: ${err instanceof Error ? err.message : "unknown"} (raw OK)`,
                current: ++finished,
                total: collectedUrls.length,
              });
            }
          } catch (err) {
            send({
              type: "page",
              message: `Error on page ${num}: ${err instanceof Error ? err.message : "unknown"}`,
              current: ++finished,
              total: collectedUrls.length,
            });
          }
        };

        await Promise.all(
          collectedUrls.map((imgUrl, i) => limit(() => storeOne(imgUrl, i))),
        );

        const { error: issueErr } = await updateIssue(
          supabaseAdmin,
          body.bookId,
          body.issueId,
          {
            page_count: uploaded,
            has_webp: uploaded > 0,
            pipeline_step: "pages-downloaded",
            source_pages_path: `${body.bookId}/${body.issueId}/source/`,
          },
        );

        if (issueErr) {
          send({
            type: "error",
            message: `issues update failed: ${issueErr.message}`,
          });
          return;
        }

        send({
          type: "done",
          message: `Successfully uploaded ${uploaded}/${collectedUrls.length} pages`,
          current: uploaded,
          total: collectedUrls.length,
        });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function extFromUrl(url: string): string {
  const clean = url.split("?")[0] ?? url;
  const match = /\.(jpe?g|png|webp|gif)$/i.exec(clean);
  return match ? match[1]!.toLowerCase().replace("jpeg", "jpg") : "jpg";
}

/** A page's identity for the visited set: the URL without its hash. */
function pageKey(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return u.href;
}

/**
 * The browser path, for sites whose plain HTML lists too few page images. It
 * reads the confirmed URL and follows only that issue's own pagination
 * (`isSameIssuePage`): a link to another issue or another site ends the walk.
 */
async function collectWithBrowser(
  sourceUrl: string,
  send: (event: ProgressEvent) => void,
): Promise<string[]> {
  const geminiKey = process.env.GEMINI_API_KEY;
  const bbApiKey = process.env.BROWSERBASE_API_KEY;
  const bbProjectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!geminiKey || !bbApiKey || !bbProjectId) {
    throw new Error(
      "Missing GEMINI_API_KEY, BROWSERBASE_API_KEY, or BROWSERBASE_PROJECT_ID",
    );
  }

  send({ type: "status", message: "Launching browser via Browserbase..." });

  const { Stagehand } = await import("@browserbasehq/stagehand");
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: bbApiKey,
    projectId: bbProjectId,
    model: {
      modelName: `google/${GEMINI_MEDIUM}`,
      apiKey: geminiKey,
    },
    verbose: 0,
    disablePino: true,
    logger: () => undefined,
  });

  const collectedUrls: string[] = [];
  try {
    await stagehand.init();

    const page = stagehand.context.pages()[0];
    if (!page) throw new Error("No browser page after init");

    send({ type: "status", message: "Navigating to source URL..." });
    await page.goto(sourceUrl, { waitUntil: "load" });

    // Try setting "All pages" reading mode
    const modeSet = await page.evaluate(() => {
      const sel = document.querySelector<HTMLSelectElement>("#selectReadType");
      if (!sel) return false;
      sel.value = "1";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
    if (modeSet) {
      send({ type: "status", message: "Set reading mode to All Pages" });
      await new Promise((r) => setTimeout(r, 1500));
    }

    const pageSchema = z.object({
      pages: z
        .array(
          z.object({
            url: z.string().url().describe("Full URL of the comic page image"),
            pageNumber: z
              .number()
              .optional()
              .describe("Page number if visible"),
          }),
        )
        .describe("All comic book page images found on this page"),
    });

    const seenUrls = new Set<string>();
    const visited = new Set<string>();

    while (visited.size < MAX_ISSUE_PAGES) {
      // A redirect off the confirmed issue ends the walk before anything is read.
      const here = await page.evaluate(() => location.href);
      if (!isSameIssuePage(here, sourceUrl)) {
        send({
          type: "status",
          message: `Left the confirmed issue (now at ${here}); stopped.`,
        });
        break;
      }
      visited.add(pageKey(here));

      send({ type: "status", message: "Scrolling to load all images..." });
      await scrollToLoadImages(page);

      send({ type: "status", message: "Extracting page image URLs..." });
      const result = await stagehand.extract(
        "Extract all comic book page image URLs from this page. Include only the full-size page images, not thumbnails, icons, ads, navigation buttons, or UI elements.",
        pageSchema,
      );

      for (const p of result.pages) {
        if (!seenUrls.has(p.url)) {
          seenUrls.add(p.url);
          collectedUrls.push(p.url);
        }
      }

      send({
        type: "status",
        message: `Found ${collectedUrls.length} page image(s)...`,
      });

      if (result.pages.length >= MIN_PAGE_IMAGES) break;

      // Pagination: only this issue's own pages (`?page=2`, `/2/`), never a
      // next-issue or other-site link.
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

      send({ type: "status", message: `Opening ${next} (same issue)...` });
      await page.goto(next, { waitUntil: "load" });
    }
  } finally {
    try {
      await stagehand.close();
    } catch (closeErr) {
      console.error("download-pages: stagehand.close() failed:", closeErr);
    }
  }
  return collectedUrls;
}

interface ScrollablePage {
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  waitForLoadState(state: string): Promise<void>;
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
