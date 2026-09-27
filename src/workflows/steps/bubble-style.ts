/** Pixel box_2d geometry (top-left origin), as stored on bubbles. */
export type BubbleBox2d = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
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
export function hasPixelBox2d(box2d: unknown): box2d is BubbleBox2d {
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
 * Why addBubbleStyles would skip this bubble, or null when it should write.
 * Shared by the step and scripts/check-bubble-styles.ts.
 */
export function getBubbleStyleSkipReason(
  bubble: { style: unknown; box_2d: unknown },
  pageDims: PageDims | null | undefined,
): string | null {
  if (bubble.style != null) return "style already set";
  if (pageDims == null) return "no page dims";
  if (pageDims.width <= 0 || pageDims.height <= 0) return "invalid page dims";
  if (!hasPixelBox2d(bubble.box_2d)) return "incomplete box_2d";
  return null;
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
  return getBubbleStyleSkipReason(bubble, pageDims) === null;
}
