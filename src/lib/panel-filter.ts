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

const DUPLICATE_COVER = 0.9;

export const area = (b: PanelBoundingBox) => b.w * b.h;

export function intersectArea(
  a: PanelBoundingBox,
  b: PanelBoundingBox,
): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Share of `box` covered by the union of `others`, exact on the grid their edges make. */
function unionCoverage(box: PanelBoundingBox, others: PanelBoundingBox[]) {
  const clip = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), hi);
  const xs = new Set([box.x, box.x + box.w]);
  const ys = new Set([box.y, box.y + box.h]);
  for (const o of others) {
    xs.add(clip(o.x, box.x, box.x + box.w));
    xs.add(clip(o.x + o.w, box.x, box.x + box.w));
    ys.add(clip(o.y, box.y, box.y + box.h));
    ys.add(clip(o.y + o.h, box.y, box.y + box.h));
  }
  const sx = [...xs].sort((a, b) => a - b);
  const sy = [...ys].sort((a, b) => a - b);
  let covered = 0;
  for (let i = 0; i + 1 < sx.length; i++) {
    for (let j = 0; j + 1 < sy.length; j++) {
      const p = { x: (sx[i]! + sx[i + 1]!) / 2, y: (sy[j]! + sy[j + 1]!) / 2 };
      if (others.some((o) => containsPoint(o, p))) {
        covered += (sx[i + 1]! - sx[i]!) * (sy[j + 1]! - sy[j]!);
      }
    }
  }
  return area(box) > 0 ? covered / area(box) : 1;
}

/**
 * Split panel detections into kept and dropped, dropping a box that repeats
 * art other boxes already show (#225). A bubble center belongs to the
 * smallest box holding it, the rule bubbles are linked by. A box that owns a
 * bubble center is always kept. A box that owns none is dropped when either:
 *
 * - smaller kept boxes cover 0.9 or more of its area: it is a duplicate of
 *   one of them, or the union of the panels inside it; or
 * - 0.9 or more of it lies inside one larger kept box and it spans 0.9 or
 *   more of that box's width or height: it is a strip cut from that panel.
 *
 * A small box sitting inside a larger one without spanning it is an inset,
 * kept even when it holds no bubble (a silent inset of sound effects).
 * Boxes are judged largest first against the ones still kept, so two copies
 * of one silent panel keep one copy. Order is preserved in both lists.
 */
export function filterDuplicatePanels<T extends FilterablePanel>(
  panels: T[],
  bubbleCenters: BubbleCenter[],
): { kept: T[]; dropped: T[] } {
  const owners = new Set<T>();
  for (const c of bubbleCenters) {
    const holders = panels.filter((p) => containsPoint(p.bounding_box, c));
    const smallest = holders.sort(
      (a, b) => area(a.bounding_box) - area(b.bounding_box),
    )[0];
    if (smallest) owners.add(smallest);
  }

  const dropped = new Set<T>();
  const bySize = [...panels].sort(
    (a, b) => area(b.bounding_box) - area(a.bounding_box),
  );
  for (const panel of bySize) {
    if (owners.has(panel)) continue;
    const box = panel.bounding_box;
    const others = panels.filter((p) => p !== panel && !dropped.has(p));
    const smaller = others
      .filter((p) => area(p.bounding_box) <= area(box))
      .map((p) => p.bounding_box);
    const isCoveredBySmaller = unionCoverage(box, smaller) >= DUPLICATE_COVER;
    const isStrip = others.some(({ bounding_box: l }) => {
      if (area(l) <= area(box)) return false;
      if (intersectArea(box, l) < DUPLICATE_COVER * area(box)) return false;
      return box.w >= DUPLICATE_COVER * l.w || box.h >= DUPLICATE_COVER * l.h;
    });
    if (isCoveredBySmaller || isStrip) dropped.add(panel);
  }
  return {
    kept: panels.filter((p) => !dropped.has(p)),
    dropped: panels.filter((p) => dropped.has(p)),
  };
}
