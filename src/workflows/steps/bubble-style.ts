/** Pixel box_2d geometry (top-left origin), as stored on bubbles. */
export type BubbleBox2d = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

/** box_2d with all four numeric pixel fields present. */
export type PixelBox2d = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Percentage string style written to bubbles.style jsonb. */
export type BubbleStyle = {
  left: string;
  top: string;
  width: string;
  height: string;
};

export type PageDims = {
  width: number;
  height: number;
};

/** Inputs proven ready for computeBubbleStyle by the write predicate. */
export type BubbleStyleReady = {
  pageWidth: number;
  pageHeight: number;
  box2d: PixelBox2d;
};

/**
 * Pure style math from scripts/add-bubble-styles.ts calculateStyle.
 * Returns null when box_2d lacks numeric x, y, width, or height, or when
 * page dims are not positive.
 */
export function computeBubbleStyle(
  box2d: BubbleBox2d | null | undefined,
  pageWidth: number,
  pageHeight: number,
): BubbleStyle | null {
  if (pageWidth <= 0 || pageHeight <= 0) return null;
  if (!box2d) return null;
  const { x, y, width, height } = box2d;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }

  const percentX = (x / pageWidth) * 100;
  const percentY = (y / pageHeight) * 100;
  const percentWidth = (width / pageWidth) * 100;
  const percentHeight = (height / pageHeight) * 100;

  return {
    left: `${percentX.toFixed(2)}%`,
    top: `${percentY.toFixed(2)}%`,
    width: `${percentWidth.toFixed(2)}%`,
    height: `${percentHeight.toFixed(2)}%`,
  };
}

/** True when box_2d has numeric pixel x, y, width, height. */
export function hasPixelBox2d(box2d: unknown): box2d is PixelBox2d {
  if (!box2d || typeof box2d !== "object") return false;
  const box = box2d as Record<string, unknown>;
  return (
    typeof box.x === "number" &&
    typeof box.y === "number" &&
    typeof box.width === "number" &&
    typeof box.height === "number"
  );
}

/**
 * Why addBubbleStyles would skip this bubble, or the narrowed dims and box
 * when it should write. Shared by the step and scripts/check-bubble-styles.ts.
 */
export function getBubbleStyleSkipReason(
  bubble: { style: unknown; box_2d: unknown },
  pageDims: PageDims | null | undefined,
): { ready: BubbleStyleReady } | { skip: string } {
  if (bubble.style != null) return { skip: "style already set" };
  if (pageDims == null) return { skip: "no page dims" };
  if (pageDims.width <= 0 || pageDims.height <= 0) {
    return { skip: "invalid page dims" };
  }
  if (!hasPixelBox2d(bubble.box_2d)) return { skip: "incomplete box_2d" };
  return {
    ready: {
      pageWidth: pageDims.width,
      pageHeight: pageDims.height,
      box2d: bubble.box_2d,
    },
  };
}

/**
 * Same filter addBubbleStyles uses: style is null, page dims are present
 * and positive, and box_2d has numeric x, y, width, and height.
 * Existing styles are never overwritten.
 */
export function shouldWriteBubbleStyle(
  bubble: { style: unknown; box_2d: unknown },
  pageDims: PageDims | null | undefined,
): boolean {
  return "ready" in getBubbleStyleSkipReason(bubble, pageDims);
}
