/**
 * Small geometry utilities used by extract-foreground-masks.
 *
 * Coordinate systems used here:
 *   "page"  = pixels in the original page image (what Roboflow returns).
 *   "panel" = 0..1 fractions relative to the panel's bounding box.
 *
 * Roboflow's box format puts (x, y) at the BOX CENTER. We convert to a
 * top-left "Box" first via {@link rfBoxToTopLeftBox}.
 */

export interface PointPx {
  x: number;
  y: number;
}

export interface PointFrac {
  x: number;
  y: number;
}

/** Top-left bbox in pixels. */
export interface BoxPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Top-left bbox in 0..1 page-space fractions. */
export interface BoxFrac {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RoboflowBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rfBoxToTopLeftBox(b: RoboflowBox): BoxPx {
  return {
    x: b.x - b.width / 2,
    y: b.y - b.height / 2,
    w: b.width,
    h: b.height,
  };
}

export function pointInBox(p: PointPx, box: BoxPx): boolean {
  return (
    p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h
  );
}

export function polygonCentroid(points: PointPx[]): PointPx {
  // Vertex-average centroid — fast, accurate enough for assignment.
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const n = points.length || 1;
  return { x: sx / n, y: sy / n };
}

/** Convert a page-pixel point to panel-local 0..1. */
export function toPanelLocal(p: PointPx, panel: BoxPx): PointFrac {
  return { x: (p.x - panel.x) / panel.w, y: (p.y - panel.y) / panel.h };
}

/** Convert a page bbox to 0..1 page-space fractions. */
export function toPageFrac(
  panel: BoxPx,
  imageWidth: number,
  imageHeight: number,
): BoxFrac {
  return {
    x: panel.x / imageWidth,
    y: panel.y / imageHeight,
    w: panel.w / imageWidth,
    h: panel.h / imageHeight,
  };
}

/**
 * Ramer–Douglas–Peucker line simplification.
 * `epsilon` is in the same units as the points (use ~0.005 for panel-local 0..1
 * coordinates, i.e. ½ % of panel size).
 */
export function rdpSimplify(points: PointFrac[], epsilon: number): PointFrac[] {
  if (points.length < 3) return points.slice();

  const a = points[0];
  const b = points[points.length - 1];
  if (!a || !b) return points.slice();

  let dmax = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    if (!p) continue;
    const d = perpDist(p, a, b);
    if (d > dmax) {
      dmax = d;
      index = i;
    }
  }

  if (dmax > epsilon) {
    const left = rdpSimplify(points.slice(0, index + 1), epsilon);
    const right = rdpSimplify(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

function perpDist(p: PointFrac, a: PointFrac, b: PointFrac): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  const num = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x);
  const den = Math.hypot(dx, dy);
  return num / den;
}

/**
 * Iteratively bump epsilon until the simplified polygon has at most `maxVerts`
 * vertices. Saves us from picking a magic epsilon for variable-density input.
 */
export function rdpSimplifyToBudget(
  points: PointFrac[],
  maxVerts: number,
  startEpsilon = 0.003,
): PointFrac[] {
  if (points.length <= maxVerts) return points.slice();
  let eps = startEpsilon;
  let simplified = rdpSimplify(points, eps);
  // Geometric backoff: 1.5x epsilon until we're under budget. ~10 iters max.
  for (let i = 0; i < 12 && simplified.length > maxVerts; i++) {
    eps *= 1.5;
    simplified = rdpSimplify(points, eps);
  }
  return simplified;
}
