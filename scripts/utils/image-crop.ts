/**
 * Image cropping utilities
 */

import sharp from "sharp";
import type { Box2D } from "./box-math.js";

/**
 * Apply padding to a bounding box
 */
export function applyPadding(box: Box2D, padding: number = 0): Box2D {
  if (padding <= 0) {
    return {
      x: Math.floor(box.x),
      y: Math.floor(box.y),
      width: Math.floor(box.width),
      height: Math.floor(box.height),
    };
  }

  return {
    x: Math.max(0, Math.floor(box.x - box.width * padding)),
    y: Math.max(0, Math.floor(box.y - box.height * padding)),
    width: Math.max(1, Math.floor(box.width * (1 + padding * 2))),
    height: Math.max(1, Math.floor(box.height * (1 + padding * 2))),
  };
}

/**
 * Clamp box coordinates to image bounds and ensure integer values
 */
export function clampBoxToBounds(
  box: Box2D,
  maxWidth: number,
  maxHeight: number,
): Box2D {
  const extractLeft = Math.floor(Math.min(box.x, maxWidth - 1));
  const extractTop = Math.floor(Math.min(box.y, maxHeight - 1));
  const extractWidth = Math.floor(Math.min(box.width, maxWidth - extractLeft));
  const extractHeight = Math.floor(
    Math.min(box.height, maxHeight - extractTop),
  );

  return {
    x: Math.max(0, extractLeft),
    y: Math.max(0, extractTop),
    width: Math.max(1, extractWidth),
    height: Math.max(1, extractHeight),
  };
}

/**
 * Extract and crop an image region
 */
export async function cropImage(
  imageBuffer: Buffer,
  box: Box2D,
): Promise<Buffer> {
  const imageMetadata = await sharp(imageBuffer).metadata();
  const maxWidth = imageMetadata.width ?? 0;
  const maxHeight = imageMetadata.height ?? 0;

  const clampedBox = clampBoxToBounds(box, maxWidth, maxHeight);

  return await sharp(imageBuffer)
    .extract({
      left: clampedBox.x,
      top: clampedBox.y,
      width: clampedBox.width,
      height: clampedBox.height,
    })
    .toBuffer();
}
