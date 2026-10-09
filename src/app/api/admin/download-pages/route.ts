import "server-only";
import { type NextRequest } from "next/server";
import pLimit from "p-limit";
import { z } from "zod";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { storePageImage } from "~/lib/page-images";
import { selectIssue, updateIssue } from "~/lib/issue-queries";
import { collectPageImages } from "~/lib/add-content/collect-pages";
import { countIssuePages } from "~/lib/add-content/issue-pages";
import { MIN_PAGE_IMAGES } from "~/lib/add-content/page-images";
import { isPublicHttpUrl } from "~/lib/add-content/public-url";

// A browser read plus three-at-a-time storage can run for minutes.
export const maxDuration = 300;

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

/**
 * Stores the pages of the issue's confirmed `source_url`, read from the
 * `issues` row; the client sends no URL (#792). The image list comes from
 * `collectPageImages`, the same read the Check step counted. Nothing is stored
 * unless the list matches the count Doug confirmed.
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
        const existingPages = await countIssuePages(body.bookId, body.issueId);
        if (existingPages > 0) {
          send({
            type: "error",
            message: `${body.bookId}/${body.issueId} already has ${existingPages} pages. Nothing was stored.`,
          });
          return;
        }

        send({ type: "status", message: `Reading ${sourceUrl}...` });
        const collected = await collectPageImages(sourceUrl, (message) =>
          send({ type: "status", message }),
        );
        const collectedUrls = collected.imageUrls;

        if (collectedUrls.length < MIN_PAGE_IMAGES) {
          send({
            type: "error",
            message: `Found ${collectedUrls.length} page image(s) on the confirmed issue${collected.pageTitle ? ` ("${collected.pageTitle}")` : ""} and stopped. Nothing was stored.`,
          });
          return;
        }

        if (collectedUrls.length !== body.expectedCount) {
          send({
            type: "error",
            message: `Found ${collectedUrls.length} page images, but ${body.expectedCount} were confirmed. Nothing was stored; check the source again.`,
          });
          return;
        }

        // The read above can take minutes; re-check just before the first write.
        const pagesNow = await countIssuePages(body.bookId, body.issueId);
        if (pagesNow > 0) {
          send({
            type: "error",
            message: `${body.bookId}/${body.issueId} got ${pagesNow} pages while reading. Nothing was stored.`,
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
            const landedType = imgResponse.headers.get("content-type") ?? "";
            if (
              imgResponse.ok &&
              (!isPublicHttpUrl(imgResponse.url) ||
                /^(text|application\/(json|xml))/i.test(landedType))
            ) {
              send({
                type: "page",
                message: `Skipped page ${num}: not an image from a public URL (${landedType})`,
                current: ++finished,
                total: collectedUrls.length,
              });
              return;
            }
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
