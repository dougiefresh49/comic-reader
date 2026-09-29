import type { PanelBoundingBox } from "~/types/panels";

/** A bubble center, page-normalized like the panel boxes. */
export type BubbleCenter = { x: number; y: number };

/** Anything carrying a page-normalized panel box. */
export type FilterablePanel = { bounding_box: PanelBoundingBox };

const SLIVER_MAX_W = 0.08;
const SLIVER_MAX_H = 0.06;

function containsPoint(box: PanelBoundingBox, p: BubbleCenter): boolean {
  return (
    p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h
  );
}

/**
 * Split panel detections into kept and dropped. A panel is a sliver, and
 * dropped, when it is thinner than 0.08 of the page wide or 0.06 tall and
 * no bubble center falls inside it: panel view would stop on it with
 * nothing to read (#99). Order is preserved in both lists.
 */
export function filterSliverPanels<T extends FilterablePanel>(
  panels: T[],
  bubbleCenters: BubbleCenter[],
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const panel of panels) {
    const box = panel.bounding_box;
    const isThin = box.w < SLIVER_MAX_W || box.h < SLIVER_MAX_H;
    const isSliver =
      isThin && !bubbleCenters.some((c) => containsPoint(box, c));
    (isSliver ? dropped : kept).push(panel);
  }
  return { kept, dropped };
}
