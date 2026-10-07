import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decodeRawImage,
  pixelBoxOf,
  sampleFillColorRaw,
  type RawImage,
} from "~/lib/bubble-fill";
import { cloudVisionGeometry } from "~/lib/cloud-vision-geometry";
import { pageStoragePath } from "~/lib/storage";
import {
  assignLinesToBubbles,
  whereWordGeometryCandidate,
} from "~/lib/word-geometry-assign";
import type { Database, Json } from "~/types/database";

/**
 * A failure a retry would not cure: the bubbles read, the page download, or a
 * `text_geometry` update. The pipeline step turns it into a `FatalError`; a
 * Cloud Vision failure stays a plain `Error`, which the step's runtime retries.
 */
export class WordGeometryDataError extends Error {
  override name = "WordGeometryDataError";
}

/**
 * Word boxes for one page (#573): OCRs the stored page image with Cloud
 * Vision, assigns its lines to the page's candidate bubbles and writes
 * `bubbles.text_geometry`, null where no line was assigned, the same
 * `text_geometry` write as the `--write` loop of
 * `scripts/ocr-word-geometry.ts`. The pipeline runs it after the
 * `review-pages` gate, so the text and rects the owner fixed are the ones
 * boxed; the review editor's Save runs it on a page whose candidate box it
 * wrote (#620). Under DRY_RUN the engine returns no lines and every candidate
 * is written null. A page with no candidate bubbles makes no Cloud Vision call.
 *
 * A bubble given word boxes has its `fill_color` resampled with them skipped
 * (#597), in the same update. A page image that fails to decode logs one
 * warning and leaves every fill as it was; a null-geometry bubble keeps its.
 */
export async function wordGeometryForPage(
  supabase: SupabaseClient<Database>,
  bookId: string,
  issueId: string,
  pageNumber: number,
) {
  const pageLabel = `page-${String(pageNumber).padStart(2, "0")}`;

  const { data: bubbles, error: bubblesErr } = await whereWordGeometryCandidate(
    supabase
      .from("bubbles")
      .select("id, style, text_with_cues, ocr_text, box_2d")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", pageNumber),
  ).order("sort_order");
  if (bubblesErr) {
    throw new WordGeometryDataError(
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
    throw new WordGeometryDataError(
      `comic-pages download failed for ${pageLabel}: ${downloadErr?.message ?? "no image"}`,
    );
  }
  const image = new Uint8Array(await imageBlob.arrayBuffer());

  // A Cloud Vision HTTP error is a plain Error, which the runtime retries.
  const geometry = await cloudVisionGeometry(image);
  const assigned = assignLinesToBubbles(bubbles, geometry);

  let raw: RawImage | null = null;
  if (assigned.bubbles.some((a) => a.geometry)) {
    try {
      raw = await decodeRawImage(image);
    } catch (err) {
      console.warn(
        `[word-geometry] ${pageLabel}: page image did not decode, fill colours left as they were (${(err as Error).message})`,
      );
    }
  }

  let withGeometry = 0;
  for (const a of assigned.bubbles) {
    const box = pixelBoxOf(a.bubble.box_2d);
    const { data, error } = await supabase
      .from("bubbles")
      .update({
        text_geometry: a.geometry as Json | null,
        ...(raw && box && a.geometry
          ? { fill_color: sampleFillColorRaw(raw, box, a.geometry) }
          : {}),
      })
      .eq("id", a.bubble.id)
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .select("id");
    if (error) {
      throw new WordGeometryDataError(
        `text_geometry update failed for ${pageLabel} bubble ${a.bubble.id}: ${error.message}`,
      );
    }
    if (data.length !== 1) {
      throw new WordGeometryDataError(
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
