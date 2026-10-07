import { FatalError } from "workflow";
import { cloudVisionGeometry } from "~/lib/cloud-vision-geometry";
import { isDryRun } from "~/lib/fakes/dry-run";
import { pageStoragePath } from "~/lib/storage";
import {
  assignLinesToBubbles,
  whereWordGeometryCandidate,
} from "~/lib/word-geometry-assign";
import type { Json } from "~/types/database";

/**
 * Word boxes for one page (#573): OCRs the stored page image with Cloud
 * Vision, assigns its lines to the page's candidate bubbles and writes
 * `bubbles.text_geometry`, null where no line was assigned, the same update
 * as the `--write` loop of `scripts/ocr-word-geometry.ts`. Runs after the
 * `review-pages` gate, so the text and rects the owner fixed are the ones
 * boxed. Under DRY_RUN the engine returns no lines and every candidate is
 * written null. A page with no candidate bubbles makes no Cloud Vision call.
 */
export async function wordGeometryPage(
  bookId: string,
  issueId: string,
  pageNumber: number,
) {
  "use step";
  // Checked before any page work, so a missing key fails the run at
  // `failed:word-geometry` instead of the engine's plain (retried) error.
  if (!isDryRun()) {
    const { env } = await import("~/env.mjs");
    if (!env.GOOGLE_CLOUD_VISION_API_KEY) {
      throw new FatalError(
        "GOOGLE_CLOUD_VISION_API_KEY required for the word-geometry step",
      );
    }
  }

  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();
  const pageLabel = `page-${String(pageNumber).padStart(2, "0")}`;

  const { data: bubbles, error: bubblesErr } = await whereWordGeometryCandidate(
    supabase
      .from("bubbles")
      .select("id, style, text_with_cues, ocr_text")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", pageNumber),
  ).order("sort_order");
  if (bubblesErr) {
    throw new FatalError(
      `bubbles read failed for ${pageLabel}: ${bubblesErr.message}`,
    );
  }
  if (bubbles.length === 0) {
    console.log(`[word-geometry] ${pageLabel}: no candidate bubbles`);
    return { candidates: 0, withGeometry: 0 };
  }

  const { data: imageBlob, error: downloadErr } = await supabase.storage
    .from("comic-pages")
    .download(pageStoragePath(bookId, issueId, pageNumber));
  if (downloadErr || !imageBlob) {
    throw new FatalError(
      `comic-pages download failed for ${pageLabel}: ${downloadErr?.message ?? "no image"}`,
    );
  }
  const image = new Uint8Array(await imageBlob.arrayBuffer());

  // A Cloud Vision HTTP error is a plain Error, which the runtime retries.
  const geometry = await cloudVisionGeometry(image);
  const assigned = assignLinesToBubbles(bubbles, geometry);

  let withGeometry = 0;
  for (const a of assigned.bubbles) {
    const { data, error } = await supabase
      .from("bubbles")
      .update({ text_geometry: a.geometry as Json | null })
      .eq("id", a.bubble.id)
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .select("id");
    if (error) {
      throw new FatalError(
        `text_geometry update failed for ${pageLabel} bubble ${a.bubble.id}: ${error.message}`,
      );
    }
    if (data.length !== 1) {
      throw new FatalError(
        `text_geometry update for ${pageLabel} bubble ${a.bubble.id} matched ${data.length} rows`,
      );
    }
    if (a.geometry) withGeometry++;
  }

  console.log(
    `[word-geometry] ${pageLabel}: ${geometry.lines.length} lines, ${withGeometry} of ${bubbles.length} bubbles have word boxes`,
  );
  return { candidates: bubbles.length, withGeometry };
}
