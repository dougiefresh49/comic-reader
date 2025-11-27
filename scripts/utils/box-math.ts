/**
 * Box math utility functions for bounding box calculations
 */

export interface Box2D {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Calculate intersection over union (IoU) for two boxes
 */
export function calculateIoU(box1: Box2D, box2: Box2D): number {
  const x1 = Math.max(box1.x, box2.x);
  const y1 = Math.max(box1.y, box2.y);
  const x2 = Math.min(box1.x + box1.width, box2.x + box2.width);
  const y2 = Math.min(box1.y + box1.height, box2.y + box2.height);

  if (x2 < x1 || y2 < y1) return 0;

  const intersection = (x2 - x1) * (y2 - y1);
  const area1 = box1.width * box1.height;
  const area2 = box2.width * box2.height;
  const union = area1 + area2 - intersection;

  return union > 0 ? intersection / union : 0;
}

/**
 * Check if two boxes are nearly identical (within tolerance)
 */
export function boxesAreSimilar(
  box1: Box2D,
  box2: Box2D,
  tolerance: number = 0.05,
): boolean {
  const xDiff = Math.abs(box1.x - box2.x) / Math.max(box1.width, box2.width);
  const yDiff = Math.abs(box1.y - box2.y) / Math.max(box1.height, box2.height);
  const wDiff =
    Math.abs(box1.width - box2.width) / Math.max(box1.width, box2.width);
  const hDiff =
    Math.abs(box1.height - box2.height) / Math.max(box1.height, box2.height);

  return (
    xDiff < tolerance &&
    yDiff < tolerance &&
    wDiff < tolerance &&
    hDiff < tolerance
  );
}

/**
 * Check if boxes overlap significantly
 */
export function boxesOverlap(box1: Box2D, box2: Box2D): boolean {
  return calculateIoU(box1, box2) > 0.1; // 10% overlap threshold
}

/**
 * Check if box1 is completely inside box2 (box2 contains box1)
 */
export function isInside(innerBox: Box2D, outerBox: Box2D): boolean {
  const innerRight = innerBox.x + innerBox.width;
  const innerBottom = innerBox.y + innerBox.height;
  const outerRight = outerBox.x + outerBox.width;
  const outerBottom = outerBox.y + outerBox.height;

  return (
    innerBox.x >= outerBox.x &&
    innerBox.y >= outerBox.y &&
    innerRight <= outerRight &&
    innerBottom <= outerBottom
  );
}
