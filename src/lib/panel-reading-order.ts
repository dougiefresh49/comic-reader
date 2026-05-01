import type { PageDirectedPanel } from "~/types/panels";

/**
 * Sort panels into Western reading order (top→bottom, left→right).
 *
 * Two panels share a row when their TOP edges are close (within 30% of
 * the smaller panel's height). We compared centers in an earlier version
 * but that misordered pages where a tall vertical strip and a much wider
 * shorter panel had close centers despite the strip clearly starting
 * higher on the page (e.g. issue-1 page-3: a tall left strip and a wide
 * mid-page panel got swapped).
 *
 * If any panel on the page was hand-placed (`source === "manual"`), the
 * persisted `sortOrder` is treated as authoritative and returned unchanged.
 */
export function sortPanelsForReading(
  panels: PageDirectedPanel[],
): PageDirectedPanel[] {
  if (panels.length < 2) return panels;
  if (panels.some((p) => p.source === "manual")) {
    return panels.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  }

  return panels.slice().sort((a, b) => {
    const ay = a.boundingBox.y;
    const by = b.boundingBox.y;
    const ah = a.boundingBox.h;
    const bh = b.boundingBox.h;
    const tolerance = Math.min(ah, bh) * 0.3;

    if (Math.abs(ay - by) <= tolerance) {
      return a.boundingBox.x - b.boundingBox.x;
    }
    return ay - by;
  });
}
