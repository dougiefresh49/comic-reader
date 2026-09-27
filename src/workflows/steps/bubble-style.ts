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

/**
 * Pure style math from scripts/add-bubble-styles.ts calculateStyle.
 * Returns null when box_2d lacks numeric x, y, width, or height.
 */
export function computeBubbleStyle(
  box2d: BubbleBox2d | null | undefined,
  pageWidth: number,
  pageHeight: number,
): BubbleStyle | null {
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

/**
 * Same filter addBubbleStyles uses: style is null and box_2d has
 * numeric width and height. Existing styles are never overwritten.
 */
export function shouldWriteBubbleStyle(bubble: {
  style: unknown;
  box_2d: unknown;
}): boolean {
  if (bubble.style != null) return false;
  if (!bubble.box_2d || typeof bubble.box_2d !== "object") return false;
  const box = bubble.box_2d as Record<string, unknown>;
  return typeof box.width === "number" && typeof box.height === "number";
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
