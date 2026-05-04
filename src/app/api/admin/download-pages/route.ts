import "server-only";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { GEMINI_MEDIUM } from "~/lib/models";

const RAW_BUCKET = "comic-pages-raw";

interface ProgressEvent {
  type: "status" | "page" | "done" | "error";
  message: string;
  current?: number;
  total?: number;
}

function encodeEvent(event: ProgressEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    bookId: string;
    issueId: string;
    sourceUrl: string;
  };

  if (!body.bookId || !body.issueId || !body.sourceUrl) {
    return Response.json({ error: "missing fields" }, { status: 400 });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const bbApiKey = process.env.BROWSERBASE_API_KEY;
  const bbProjectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!geminiKey || !bbApiKey || !bbProjectId) {
    return Response.json(
      {
        error:
          "Missing GEMINI_API_KEY, BROWSERBASE_API_KEY, or BROWSERBASE_PROJECT_ID",
      },
      { status: 500 },
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ProgressEvent) => {
        controller.enqueue(new TextEncoder().encode(encodeEvent(event)));
      };

      try {
        send({
          type: "status",
          message: "Launching browser via Browserbase...",
        });

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

        await stagehand.init();

        const page = stagehand.context.pages()[0];
        if (!page) throw new Error("No browser page after init");

        send({ type: "status", message: "Navigating to source URL..." });
        await page.goto(body.sourceUrl, { waitUntil: "load" });

        // Try setting "All pages" reading mode
        const modeSet = await page.evaluate(() => {
          const sel =
            document.querySelector<HTMLSelectElement>("#selectReadType");
          if (!sel) return false;
          sel.value = "1";
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        });
        if (modeSet) {
          send({ type: "status", message: "Set reading mode to All Pages" });
          await new Promise((r) => setTimeout(r, 1500));
        }

        send({ type: "status", message: "Scrolling to load all images..." });
        await scrollToLoadImages(page);

        send({ type: "status", message: "Extracting page image URLs..." });

        const pageSchema = z.object({
          pages: z
            .array(
              z.object({
                url: z
                  .string()
                  .url()
                  .describe("Full URL of the comic page image"),
                pageNumber: z
                  .number()
                  .optional()
                  .describe("Page number if visible"),
              }),
            )
            .describe("All comic book page images found on this page"),
        });

        const collectedUrls: string[] = [];
        const seenUrls = new Set<string>();
        let paginationAttempts = 0;
        const MAX_PAGINATION = 50;

        while (paginationAttempts <= MAX_PAGINATION) {
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

          if (result.pages.length >= 3) break;

          const observed = await stagehand.observe(
            "Is there a next page button, next arrow, or pagination control to navigate to more comic pages?",
          );
          if (!observed || observed.length === 0) break;

          await stagehand.act(
            "click the next page button or arrow to go to the next comic page",
          );
          await page.waitForLoadState("load");
          paginationAttempts++;
        }

        await stagehand.close();

        if (collectedUrls.length === 0) {
          send({
            type: "error",
            message:
              "Could not detect any page images. The site may use canvas rendering or DRM.",
          });
          controller.close();
          return;
        }

        send({
          type: "status",
          message: `Uploading ${collectedUrls.length} pages to storage...`,
          total: collectedUrls.length,
        });

        let uploaded = 0;
        for (let i = 0; i < collectedUrls.length; i++) {
          const imgUrl = collectedUrls[i]!;
          const num = String(i + 1).padStart(2, "0");
          const ext = extFromUrl(imgUrl);
          const filename = `page-${num}.${ext}`;
          const storagePath = `${body.bookId}/${body.issueId}/source/${filename}`;

          try {
            const imgResponse = await fetch(imgUrl);
            if (!imgResponse.ok) {
              send({
                type: "page",
                message: `Failed to download page ${num}: HTTP ${imgResponse.status}`,
                current: i + 1,
                total: collectedUrls.length,
              });
              continue;
            }

            const buffer = Buffer.from(await imgResponse.arrayBuffer());
            const contentType =
              imgResponse.headers.get("content-type") ??
              `image/${ext === "jpg" ? "jpeg" : ext}`;

            const { error: uploadErr } = await supabaseAdmin.storage
              .from(RAW_BUCKET)
              .upload(storagePath, buffer, {
                contentType,
                upsert: true,
              });

            if (uploadErr) {
              send({
                type: "page",
                message: `Upload failed for page ${num}: ${uploadErr.message}`,
                current: i + 1,
                total: collectedUrls.length,
              });
              continue;
            }

            uploaded++;
            send({
              type: "page",
              message: `Uploaded page ${num}`,
              current: i + 1,
              total: collectedUrls.length,
            });
          } catch (err) {
            send({
              type: "page",
              message: `Error on page ${num}: ${err instanceof Error ? err.message : "unknown"}`,
              current: i + 1,
              total: collectedUrls.length,
            });
          }
        }

        // Update issue page_count and pipeline_step
        await supabaseAdmin
          .from("issues")
          .update({
            page_count: uploaded,
            pipeline_step: "pages-downloaded",
            source_pages_path: `${body.bookId}/${body.issueId}/source/`,
          })
          .eq("id", body.issueId);

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
