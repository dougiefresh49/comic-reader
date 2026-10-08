/**
 * Spreads (#724): two facing pages drawn as one picture, stored as two
 * `pages` rows with `spread_with_next` on the left one (#723). The reader
 * shows them side by side on one plane. This module holds the rules both
 * views share, as pure functions: which pages pair up, how the counter and
 * page turns count them, how a page's 0..1 coordinates map onto the spread
 * plane, and which seam-cut panels join. Read time only; nothing is written.
 */
import type { Bubble } from "~/types";
import type {
  EffectPositions,
  PageDirectedPanel,
  PanelBoundingBox,
  PanelLocalPolygon,
} from "~/types/panels";
import type { Box, TextGeometry } from "~/types/text-geometry";

/** A panel within this share of the seam touches it (x + w ≥ 0.98, x ≤ 0.02). */
export const SEAM_EDGE = 0.02;

/** One half of a spread, as the reader renders it. */
export interface SpreadPage {
  pageNumber: number;
  image: string;
  /** The stored image size (`pages.width`, `pages.height`). */
  width: number;
  height: number;
}

/**
 * A spread on one plane. Both pages are scaled to the left page's height,
 * then laid side by side with no gap; `leftShare` is the left page's share
 * of the plane's width, and `size` is the plane in those scaled pixels.
 */
export interface ReaderSpread {
  left: SpreadPage;
  right: SpreadPage;
  leftShare: number;
  size: { w: number; h: number };
}

/**
 * The left pages of the issue's spreads, ascending. A flag on the last page
 * has no right half and is dropped, and so is a flag on a page that is
 * already the right half of the spread before it.
 */
export function normalizeSpreadStarts(
  flagged: number[],
  pageCount: number,
): number[] {
  const starts: number[] = [];
  for (const n of [...new Set(flagged)].sort((a, b) => a - b)) {
    if (n < 1 || n >= pageCount) continue;
    if (starts[starts.length - 1] === n - 1) continue;
    starts.push(n);
  }
  return starts;
}

/** The spread `page` is in, as its two page numbers, or null for a single page. */
export function spreadPagesFor(
  page: number,
  starts: number[],
): { left: number; right: number } | null {
  if (starts.includes(page)) return { left: page, right: page + 1 };
  if (starts.includes(page - 1)) return { left: page - 1, right: page };
  return null;
}

/** The counter's printed number: "8–9" (en dash) for a spread, else "8". */
export function pageLabel(page: number, starts: number[]): string {
  const spread = spreadPagesFor(page, starts);
  return spread ? `${spread.left}–${spread.right}` : String(page);
}

/**
 * The page numbers next and back land on, or null at either end. A spread
 * counts as one stop: next from 8 or 9 is 10, back from 10 is 8, back from
 * 8 or 9 is 7.
 */
export function spreadPageTurns(
  page: number,
  starts: number[],
  pageCount: number,
): { prev: number | null; next: number | null } {
  const spread = spreadPagesFor(page, starts);
  const first = spread?.left ?? page;
  const last = spread?.right ?? page;
  const next = last + 1 <= pageCount ? last + 1 : null;
  const before = first - 1;
  const prev =
    before < 1 ? null : (spreadPagesFor(before, starts)?.left ?? before);
  return { prev, next };
}

/**
 * The plane for two pages. Each is scaled to the left page's height before
 * the widths are summed, so pages of unequal height still meet edge to edge.
 */
export function spreadPlane(
  left: SpreadPage,
  right: SpreadPage,
): Pick<ReaderSpread, "leftShare" | "size"> {
  const h = left.height;
  const wL = left.width;
  const wR = right.height > 0 ? (right.width * h) / right.height : wL;
  return { leftShare: wL / (wL + wR), size: { w: wL + wR, h } };
}

type Side = "left" | "right";

/**
 * A page's x (0..1) on the spread plane: left-page x → x * wL / (wL + wR),
 * right-page x → (wL + x * wR) / (wL + wR). y is unchanged.
 */
function planeX(x: number, side: Side, leftShare: number): number {
  return side === "left" ? x * leftShare : leftShare + x * (1 - leftShare);
}

/** A page's width (0..1) on the spread plane. */
function planeW(w: number, side: Side, leftShare: number): number {
  return w * (side === "left" ? leftShare : 1 - leftShare);
}

function mapBox(
  box: PanelBoundingBox,
  side: Side,
  leftShare: number,
): PanelBoundingBox {
  return {
    x: planeX(box.x, side, leftShare),
    y: box.y,
    w: planeW(box.w, side, leftShare),
    h: box.h,
  };
}

function mapPercent(value: string, map: (n: number) => number): string {
  const n = parseFloat(value);
  return Number.isFinite(n) ? `${(map(n / 100) * 100).toFixed(4)}%` : value;
}

function mapGeometryBox([x, y, w, h]: Box, side: Side, share: number): Box {
  return [planeX(x, side, share), y, planeW(w, side, share), h];
}

function mapBubble(
  bubble: Bubble,
  side: Side,
  plane: Pick<ReaderSpread, "leftShare" | "size">,
  sortOffset: number,
): Bubble {
  const share = plane.leftShare;
  const style = bubble.style
    ? {
        left: mapPercent(bubble.style.left, (x) => planeX(x, side, share)),
        top: bubble.style.top,
        width: mapPercent(bubble.style.width, (w) => planeW(w, side, share)),
        height: bubble.style.height,
      }
    : undefined;
  const geometry: TextGeometry | null = bubble.textGeometry
    ? {
        ...bubble.textGeometry,
        // The highlight reads the plane's aspect from here.
        image: { ...bubble.textGeometry.image, ...plane.size },
        lines: bubble.textGeometry.lines.map((line) => ({
          box: mapGeometryBox(line.box, side, share),
          words: line.words.map((word) => ({
            ...word,
            box: mapGeometryBox(word.box, side, share),
          })),
        })),
      }
    : null;
  return {
    ...bubble,
    style,
    textGeometry: geometry,
    // Page 9's sort orders restart at 0; offset them past page 8's so a
    // sort over the spread's bubbles keeps page 8 first and never ties.
    sortOrder: bubble.sortOrder + sortOffset,
  };
}

/** Re-express a panel-local point (fraction of `from`) as a fraction of `to`. */
function rebasePoint(
  pt: { x: number; y: number },
  from: PanelBoundingBox,
  to: PanelBoundingBox,
): { x: number; y: number } {
  return {
    x: to.w > 0 ? (from.x + pt.x * from.w - to.x) / to.w : 0,
    y: to.h > 0 ? (from.y + pt.y * from.h - to.y) / to.h : 0,
  };
}

function rebasePolygons(
  polys: PanelLocalPolygon[],
  from: PanelBoundingBox,
  to: PanelBoundingBox,
): PanelLocalPolygon[] {
  return polys.map((poly) => poly.map((pt) => rebasePoint(pt, from, to)));
}

function rebaseEffects(
  effects: EffectPositions | null,
  from: PanelBoundingBox,
  to: PanelBoundingBox,
): EffectPositions {
  const out: EffectPositions = {};
  for (const [tag, pos] of Object.entries(effects ?? {})) {
    if (!pos.bbox) {
      out[tag] = pos;
      continue;
    }
    const [x, y, w, h] = pos.bbox;
    const a = rebasePoint({ x, y }, from, to);
    const b = rebasePoint({ x: x + w, y: y + h }, from, to);
    out[tag] = { ...pos, bbox: [a.x, a.y, b.x - a.x, b.y - a.y] };
  }
  return out;
}

function union(a: PanelBoundingBox, b: PanelBoundingBox): PanelBoundingBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

function yOverlap(a: PanelBoundingBox, b: PanelBoundingBox): number {
  return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
}

/**
 * One panel from a left-page panel and a right-page panel cut at the seam,
 * both already on the plane. Its box is their union; panel-local data
 * (foreground masks, effect boxes) is re-based onto that box. The left
 * panel's scene, speaker and audio tags stand for the pair, its bubbles
 * come first, and the camera tags of both are kept.
 */
function joinPanels(
  left: PageDirectedPanel,
  right: PageDirectedPanel,
): PageDirectedPanel {
  const box = union(left.boundingBox, right.boundingBox);
  const polygons =
    left.foregroundPolygons || right.foregroundPolygons
      ? {
          characters: [
            ...rebasePolygons(
              left.foregroundPolygons?.characters ?? [],
              left.boundingBox,
              box,
            ),
            ...rebasePolygons(
              right.foregroundPolygons?.characters ?? [],
              right.boundingBox,
              box,
            ),
          ],
          bubbles: [
            ...rebasePolygons(
              left.foregroundPolygons?.bubbles ?? [],
              left.boundingBox,
              box,
            ),
            ...rebasePolygons(
              right.foregroundPolygons?.bubbles ?? [],
              right.boundingBox,
              box,
            ),
          ],
        }
      : null;
  const effects = {
    ...rebaseEffects(right.effectPositions, right.boundingBox, box),
    ...rebaseEffects(left.effectPositions, left.boundingBox, box),
  };
  const durations = [
    left.estimatedDurationSeconds,
    right.estimatedDurationSeconds,
  ].filter((d): d is number => d != null);
  return {
    ...left,
    id: `${left.id}+${right.id}`,
    panelId: `${left.panelId}+${right.panelId}`,
    sortOrder: Math.min(left.sortOrder, right.sortOrder),
    boundingBox: box,
    effectTags: [...new Set([...left.effectTags, ...right.effectTags])],
    effectPositions: Object.keys(effects).length ? effects : null,
    estimatedDurationSeconds: durations.length
      ? durations.reduce((a, b) => a + b, 0)
      : null,
    bubbleIds: [...left.bubbleIds, ...right.bubbleIds],
    foregroundPolygons: polygons,
  };
}

/**
 * The seam-join rule (#724 item 3), on panels already mapped to the plane: a
 * left-page panel touching the seam (x + w ≥ 0.98 on its page) and a
 * right-page panel touching it (x ≤ 0.02) are one panel when their y ranges
 * overlap. Each panel joins at most once, the pair with the most y overlap
 * first. `leftShare` locates the seam on the plane.
 */
export function joinSeamPanels(
  left: PageDirectedPanel[],
  right: PageDirectedPanel[],
  leftShare: number,
): PageDirectedPanel[] {
  const seamL = (1 - SEAM_EDGE) * leftShare;
  const seamR = leftShare + SEAM_EDGE * (1 - leftShare);
  const pairs: Array<{ l: number; r: number; overlap: number }> = [];
  left.forEach((lp, l) => {
    const lb = lp.boundingBox;
    if (lb.x + lb.w < seamL) return;
    right.forEach((rp, r) => {
      const rb = rp.boundingBox;
      if (rb.x > seamR) return;
      const overlap = yOverlap(lb, rb);
      if (overlap > 0) pairs.push({ l, r, overlap });
    });
  });
  pairs.sort((a, b) => b.overlap - a.overlap);

  const partnerOfLeft = new Map<number, number>();
  const joinedRight = new Set<number>();
  for (const { l, r } of pairs) {
    if (partnerOfLeft.has(l) || joinedRight.has(r)) continue;
    partnerOfLeft.set(l, r);
    joinedRight.add(r);
  }

  return [
    ...left.map((lp, l) => {
      const r = partnerOfLeft.get(l);
      return r === undefined ? lp : joinPanels(lp, right[r]!);
    }),
    ...right.filter((_, r) => !joinedRight.has(r)),
  ];
}

/**
 * Both pages' bubbles and panels on the spread plane. Bubbles keep page
 * order (left page's in `sort_order`, then the right page's), and seam-cut
 * panels are joined. The caller sorts panels for reading as for any page.
 */
export function toSpreadPlane(
  plane: Pick<ReaderSpread, "leftShare" | "size">,
  left: { bubbles: Bubble[]; panels: PageDirectedPanel[] },
  right: { bubbles: Bubble[]; panels: PageDirectedPanel[] },
): { bubbles: Bubble[]; panels: PageDirectedPanel[] } {
  const share = plane.leftShare;
  const bubbleOffset =
    Math.max(-1, ...left.bubbles.map((b) => b.sortOrder)) + 1;
  const panelOffset = Math.max(-1, ...left.panels.map((p) => p.sortOrder)) + 1;
  const mapPanel = (p: PageDirectedPanel, side: Side, offset: number) => ({
    ...p,
    sortOrder: p.sortOrder + offset,
    boundingBox: mapBox(p.boundingBox, side, share),
  });
  return {
    bubbles: [
      ...left.bubbles.map((b) => mapBubble(b, "left", plane, 0)),
      ...right.bubbles.map((b) => mapBubble(b, "right", plane, bubbleOffset)),
    ],
    panels: joinSeamPanels(
      left.panels.map((p) => mapPanel(p, "left", 0)),
      right.panels.map((p) => mapPanel(p, "right", panelOffset)),
      share,
    ),
  };
}
