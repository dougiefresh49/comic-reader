import type { PageDirectedPanel } from "~/types/panels";

/**
 * Sort panels into Western reading order (top→bottom, left→right) using a
 * row-band heuristic. Two panels are considered to share a row when their
 * vertical centers fall within ~50% of either box's height — otherwise the
 * one with the smaller `y` comes first.
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
    const aCenter = ay + ah / 2;
    const bCenter = by + bh / 2;
    const tolerance = Math.max(ah, bh) * 0.5;

    if (Math.abs(aCenter - bCenter) <= tolerance) {
      return a.boundingBox.x - b.boundingBox.x;
    }
    return ay - by;
  });
}
