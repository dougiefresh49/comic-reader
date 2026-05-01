/**
 * Roboflow SAM3 page analysis — calls the v3 workflow that runs panel
 * detection + bubble detection + full-page SAM3 segmentation in one
 * serverless call.
 *
 * Workflow: comic-page-analyzer-v3-full-page-sam3
 *
 * Background on per-panel vs full-page: We initially built v2 with
 * per-panel SAM3 (dynamic_crop → per-panel SAM3) for tighter masks,
 * but Roboflow's dynamic_crop block has a runtime bug where it
 * sometimes fails to emit its `predictions` output, breaking the
 * pipeline on ~half of pages. Reported 2026-05-01. Until fixed, v3
 * runs SAM3 once on the full page; the extract-foreground-masks step
 * maps polygons to panel-local coords using the panel bboxes that
 * come back in the same response.
 *
 * Response shape (v3):
 *   - panel_predictions          (page-space bboxes from panel detector)
 *   - bubble_predictions         (page-space bboxes from bubble detector)
 *   - segmentation_predictions   (page-space polygons from full-page SAM3)
 */

import pLimit from "p-limit";
import { env } from "~/env.mjs";

interface SegmentationPoint {
  x: number;
  y: number;
}

interface SegmentationPrediction {
  class: "comic character" | "person" | "face" | "head" | "speech bubble";
  class_id: number;
  confidence: number;
  detection_id: string;
  parent_id: string;
  points: SegmentationPoint[];
}

interface BoxPrediction {
  /** Box CENTER x in pixels. */
  x: number;
  /** Box CENTER y in pixels. */
  y: number;
  width: number;
  height: number;
  confidence: number;
  class: string;
  class_id: number;
  detection_id: string;
}

export interface PageAnalyzeResponse {
  /** Image dimensions in pixels (full page). */
  image: { width: number; height: number };
  panel_predictions: BoxPrediction[];
  bubble_predictions: BoxPrediction[];
  segmentation_predictions: SegmentationPrediction[];
}

interface RawWorkflowOutput {
  panel_predictions?: {
    image: { width: number; height: number };
    predictions: BoxPrediction[];
  };
  bubble_predictions?: {
    image: { width: number; height: number };
    predictions: BoxPrediction[];
  };
  segmentation_predictions?: {
    image: { width: number; height: number };
    predictions: SegmentationPrediction[];
  };
}

interface RawWorkflowResponse {
  outputs?: RawWorkflowOutput[];
}

async function analyzePage(
  imageUrl: string,
  pageNumber: number,
): Promise<PageAnalyzeResponse | null> {
  const res = await fetch(env.ROBOFLOW_SAM3_WORKFLOW_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: env.ROBOFLOW_API_KEY,
      inputs: { image: { type: "url", value: imageUrl } },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn(
      `   ⚠ page-${String(pageNumber).padStart(2, "0")} SAM3 workflow ${res.status}: ${text.slice(0, 160)}`,
    );
    return null;
  }
  const data = (await res.json()) as RawWorkflowResponse;
  const out = data.outputs?.[0];
  if (!out?.panel_predictions) return null;

  return {
    image: out.panel_predictions.image,
    panel_predictions: out.panel_predictions.predictions ?? [],
    bubble_predictions: out.bubble_predictions?.predictions ?? [],
    segmentation_predictions: out.segmentation_predictions?.predictions ?? [],
  };
}

export interface AnalyzeIssueArgs {
  pageNumbers: number[];
  /** Resolves a page number to a public URL Roboflow can fetch (Supabase CDN). */
  pageUrl: (pageNumber: number) => string;
  concurrency?: number;
  delayMs?: number;
  onPage?: (pageNumber: number, result: PageAnalyzeResponse | null) => void;
}

export interface AnalyzedPage {
  pageNumber: number;
  result: PageAnalyzeResponse;
}

export async function analyzeIssuePages(
  args: AnalyzeIssueArgs,
): Promise<AnalyzedPage[]> {
  const limit = pLimit(args.concurrency ?? 2);
  const delay = args.delayMs ?? 750;
  const out: AnalyzedPage[] = [];

  await Promise.all(
    args.pageNumbers.map((pageNumber) =>
      limit(async () => {
        await new Promise((r) => setTimeout(r, delay));
        const result = await analyzePage(args.pageUrl(pageNumber), pageNumber);
        args.onPage?.(pageNumber, result);
        if (result) out.push({ pageNumber, result });
      }),
    ),
  );

  out.sort((a, b) => a.pageNumber - b.pageNumber);
  return out;
}
