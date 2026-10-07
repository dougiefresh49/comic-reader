/**
 * A bubble's fill colour, sampled from the page image under its box (#575,
 * decisions row 365). Server only: it imports sharp. No "server-only"
 * import, because the backfill script imports this too.
 *
 * Comic balloons are ovals, so the box corners are page art and the box edge
 * is the balloon outline: only pixels inside the ellipse inscribed in the
 * box, shrunk to 80%, are read. Dark pixels (lettering, outline) are dropped,
 * and the most common remaining colour, bucketed at 4 bits per channel, is
 * the fill.
 */
import sharp from "sharp";

/** A box in page pixels, top-left corner plus size. */
export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A decoded page image, so several boxes on one page decode it once. */
export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

/** The ellipse's share of the box's width and height. */
const ELLIPSE_SCALE = 0.8;
/** Below this WCAG relative luminance a pixel is lettering or outline. */
const DARK_LUMINANCE = 0.25;
/** Fewer surviving pixels than this is no fill to trust. */
const MIN_PIXELS = 20;

/** sRGB 0-255 to linear light, by table: this runs for every sampled pixel. */
const LINEAR = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** A stored `box_2d` as a pixel box, or null when it lacks numeric x, y, width and height. */
export function pixelBoxOf(box2d: unknown): PixelBox | null {
  if (box2d === null || typeof box2d !== "object") return null;
  const { x, y, width, height } = box2d as Record<string, unknown>;
  return [x, y, width, height].every(
    (n) => typeof n === "number" && Number.isFinite(n),
  )
    ? {
        x: x as number,
        y: y as number,
        width: width as number,
        height: height as number,
      }
    : null;
}

/** Decodes a page image to raw sRGB, three channels, alpha dropped. */
export async function decodeRawImage(
  image: Buffer | Uint8Array,
): Promise<RawImage> {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

/** The fill colour under `box` in an already-decoded image, lowercase `#rrggbb`, or null. */
export function sampleFillColorRaw(
  image: RawImage,
  box: PixelBox,
): string | null {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(image.height, Math.ceil(box.y + box.height));
  if (!(x1 > x0 && y1 > y0)) return null;

  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = ((x1 - x0) / 2) * ELLIPSE_SCALE;
  const ry = ((y1 - y0) / 2) * ELLIPSE_SCALE;

  const count = new Uint32Array(4096);
  const sumR = new Float64Array(4096);
  const sumG = new Float64Array(4096);
  const sumB = new Float64Array(4096);
  let kept = 0;
  const { data, width, channels } = image;
  for (let py = y0; py < y1; py++) {
    const dy = (py + 0.5 - cy) / ry;
    for (let px = x0; px < x1; px++) {
      const dx = (px + 0.5 - cx) / rx;
      if (dx * dx + dy * dy > 1) continue;
      const i = (py * width + px) * channels;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const lum =
        0.2126 * LINEAR[r]! + 0.7152 * LINEAR[g]! + 0.0722 * LINEAR[b]!;
      if (lum < DARK_LUMINANCE) continue;
      const bucket = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      count[bucket]!++;
      sumR[bucket]! += r;
      sumG[bucket]! += g;
      sumB[bucket]! += b;
      kept++;
    }
  }
  if (kept < MIN_PIXELS) return null;

  let top = 0;
  for (let k = 1; k < 4096; k++) if (count[k]! > count[top]!) top = k;
  const n = count[top]!;
  const hex = (sum: number) =>
    Math.round(sum / n)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(sumR[top]!)}${hex(sumG[top]!)}${hex(sumB[top]!)}`;
}

/** The fill colour under `box` (page pixels) in an encoded page image, or null. */
export async function sampleFillColor(
  image: Buffer | Uint8Array,
  box: PixelBox,
): Promise<string | null> {
  return sampleFillColorRaw(await decodeRawImage(image), box);
}
