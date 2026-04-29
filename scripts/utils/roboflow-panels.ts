/**
 * Roboflow panel detection — calls the trained `find-comic-panel-v1` workflow
 * and normalizes the response into our PanelDirection-compatible shape.
 *
 * Roboflow returns panel boxes in pixel coordinates, with (x, y) as the
 * BOX CENTER (not top-left). We convert to top-left fractions of the page
 * to match panels.bounding_box (jsonb { x, y, w, h } in 0..1).
 *
 * The serverless workflow API is good enough for our scale (~24 pages
 * per issue × 3 issues). For larger jobs the inference-cli batch API
 * (https://docs.roboflow.com/deploy/batch-processing/cli-usage) drops in
 * cleanly behind this same module — see TODO at the bottom.
 */

import pLimit from "p-limit";
import { env } from "~/env.mjs";

interface RoboflowPrediction {
  x: number; // center
  y: number; // center
  width: number;
  height: number;
  confidence: number;
  class: string;
  class_id: number;
  detection_id: string;
}

interface RoboflowOutput {
  predictions: {
    image: { width: number; height: number };
    predictions: RoboflowPrediction[];
  };
}

interface RoboflowResponse {
  outputs?: RoboflowOutput[];
}

export interface DetectedPanel {
  /** 0..1, top-left x */
  x: number;
  /** 0..1, top-left y */
  y: number;
  /** 0..1, width fraction */
  w: number;
  /** 0..1, height fraction */
  h: number;
  confidence: number;
  /** Roboflow's stable detection id; we don't use it as our panelId since it
   *  isn't sequential, but we keep it for traceability. */
  detectionId: string;
}

export interface DetectedPagePanels {
  pageNumber: number;
  imageWidth: number;
  imageHeight: number;
  panels: DetectedPanel[];
}

const MIN_CONFIDENCE = 0.4;

function normalizePrediction(
  p: RoboflowPrediction,
  image: { width: number; height: number },
): DetectedPanel {
  // Roboflow's (x, y) is the BOX CENTER, width/height are full extents.
  const halfW = p.width / 2;
  const halfH = p.height / 2;
  return {
    x: Math.max(0, (p.x - halfW) / image.width),
    y: Math.max(0, (p.y - halfH) / image.height),
    w: Math.min(1, p.width / image.width),
    h: Math.min(1, p.height / image.height),
    confidence: p.confidence,
    detectionId: p.detection_id,
  };
}

/**
 * Sort panels in reading order: top-to-bottom rows, left-to-right within rows.
 * Two panels are "same row" if their vertical centers are within 5% of page height.
 */
function sortReadingOrder(panels: DetectedPanel[]): DetectedPanel[] {
  const ROW_TOLERANCE = 0.05;
  return [...panels].sort((a, b) => {
    const ay = a.y + a.h / 2;
    const by = b.y + b.h / 2;
    if (Math.abs(ay - by) < ROW_TOLERANCE) {
      return a.x - b.x;
    }
    return ay - by;
  });
}

async function detectPagePanels(
  imageUrl: string,
  pageNumber: number,
): Promise<DetectedPagePanels | null> {
  const res = await fetch(env.ROBOFLOW_PANEL_WORKFLOW_URL, {
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
      `   ⚠ page-${String(pageNumber).padStart(2, "0")} Roboflow ${res.status}: ${text.slice(0, 120)}`,
    );
    return null;
  }
  const data = (await res.json()) as RoboflowResponse;
  const out = data.outputs?.[0];
  if (!out) return null;
  const image = out.predictions.image;
  const filtered = (out.predictions.predictions ?? []).filter(
    (p) => p.confidence >= MIN_CONFIDENCE,
  );
  const normalized = filtered.map((p) => normalizePrediction(p, image));
  return {
    pageNumber,
    imageWidth: image.width,
    imageHeight: image.height,
    panels: sortReadingOrder(normalized),
  };
}

export interface DetectIssueArgs {
  bookId: string;
  issueId: string;
  pageNumbers: number[];
  /** Resolves a page number to the public URL (Supabase) or local URL Roboflow can fetch. */
  pageUrl: (pageNumber: number) => string;
  concurrency?: number;
  delayMs?: number;
}

/**
 * Run panel detection across an entire issue with throttling.
 * Skips pages where detection fails — the caller decides what to do with gaps.
 */
export async function detectIssuePanels(
  args: DetectIssueArgs,
): Promise<DetectedPagePanels[]> {
  const limit = pLimit(args.concurrency ?? 2);
  const delay = args.delayMs ?? 750;
  const out: DetectedPagePanels[] = [];

  await Promise.all(
    args.pageNumbers.map((pageNumber) =>
      limit(async () => {
        await new Promise((r) => setTimeout(r, delay));
        const result = await detectPagePanels(
          args.pageUrl(pageNumber),
          pageNumber,
        );
        if (result) out.push(result);
      }),
    ),
  );

  out.sort((a, b) => a.pageNumber - b.pageNumber);
  return out;
}

/**
 * Future: drop-in batch CLI path for larger jobs.
 *
 * Pattern (per https://docs.roboflow.com/deploy/batch-processing/cli-usage):
 *   1. inference rf-cloud data-staging create-batch-of-images --references-file <jsonl> --batch-id <id>
 *   2. inference rf-cloud batch-processing process-images-with-workflow \
 *        --workflow-id find-comic-panel-v1 --batch-id <id> --machine-type cpu
 *   3. inference rf-cloud data-staging export-batch --target-dir <dir> --batch-id <output-id>
 *
 * Build the JSONL of { name, url } from the public Supabase URLs, run the
 * three commands via execFile, parse the exported JSON, return DetectedPagePanels[].
 *
 * For our current scale (~72 pages per book) the serverless API is faster
 * end-to-end than spinning up the batch CLI. Revisit when an issue has 100+
 * pages or when we move ingest to a hosted runner.
 */
