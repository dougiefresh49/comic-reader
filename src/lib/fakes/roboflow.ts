import { fixturePageFor, logSpend } from "./dry-run";

let base64Cursor = 0;

export function resetRoboflowCursor(): void {
  base64Cursor = 0;
}

/**
 * One `outputs[0]` that satisfies both workflows: the SAM3 keys read by
 * `roboflowAnalyzeBatch` and the `predictions.predictions` read by the
 * `getContextPage` fallback.
 */
export function fakeRoboflowResponse(image: {
  type: string;
  value: string;
}): Response {
  const fromUrl = /page-(\d+)\.webp/.exec(image.value)?.[1];
  const pageNumber =
    image.type === "url" && fromUrl ? Number(fromUrl) : ++base64Cursor;
  const page = fixturePageFor(pageNumber);
  logSpend("roboflow", "page", 1, "≈ $0.003/page");

  const bubbles = page.bubblePredictions.map((b) => ({
    ...b,
    class: "speech bubble",
  }));
  const output = {
    panel_predictions: {
      image: { width: page.width, height: page.height },
      predictions: page.panelPredictions.map((p) => ({ ...p, class: "panel" })),
    },
    bubble_predictions: { predictions: bubbles },
    segmentation_predictions: { predictions: page.segmentationPredictions },
    predictions: { predictions: bubbles },
  };
  return new Response(JSON.stringify({ outputs: [output] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
