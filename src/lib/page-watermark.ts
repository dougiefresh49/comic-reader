/**
 * Removes the download source's watermark from a page image (#541) without
 * moving the page's edges, so every panel and bubble box stays put.
 *
 * Two forms: a solid black banner band under the art with white text on it
 * (found by pixel work, painted black), and translucent text laid over the art
 * (found by one GEMINI_MEDIUM call, removed by a GEMINI_IMAGE_EDIT call on a
 * crop and copied back only where the edit changed pixels). Everything outside
 * a fix is the input, byte for byte. No "server-only": scripts import this.
 */
import { ThinkingLevel } from "@google/genai";
import sharp from "sharp";
import { isDryRun } from "./fakes/dry-run";
import { getGeminiClient } from "./gemini-client";
import { generateContentLogged, type LlmCallMeta } from "./llm-usage";
import { GEMINI_IMAGE_EDIT, GEMINI_MEDIUM } from "./models";

export type Box = { x: number; y: number; width: number; height: number };

export type WatermarkFix = { kind: "banner" | "overlay"; box: Box };

export type WatermarkFailure = {
  kind: "overlay";
  reason: string;
  box?: Box;
};

/** Decoded RGB pixels, 3 bytes per pixel, row-major. */
export type RgbImage = { data: Buffer; width: number; height: number };

export type CleanResult = {
  /** The input buffer when nothing changed, else a lossless PNG. */
  buffer: Buffer;
  fixes: WatermarkFix[];
  failures: WatermarkFailure[];
  /** 1 where the clean wrote a pixel, page-sized; absent when nothing changed. */
  changedMask?: { width: number; height: number; data: Uint8Array };
};

// ─── Banner: deterministic pixel work ───────────────────────────────────────

/** A band pixel is unsaturated: max channel minus min channel at most this. */
const BANNER_MAX_CHROMA = 12;
/** Share of a row's pixels that must be unsaturated. */
const BANNER_MIN_UNSATURATED = 0.99;
/** Share of a row's pixels that must be near-black. */
const BANNER_MIN_BLACK = 0.5;
const BANNER_BLACK_LUMA = 40;
const BANNER_WHITE_LUMA = 200;
const BANNER_MIN_ROWS = 60;
const BANNER_MAX_ROWS = 160;

const luma = (r: number, g: number, b: number) =>
  0.299 * r + 0.587 * g + 0.114 * b;

export async function decodeRgb(buffer: Buffer): Promise<RgbImage> {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) {
    throw new Error(`expected 3 channels after decode, got ${info.channels}`);
  }
  return { data, width: info.width, height: info.height };
}

/**
 * The black band at the bottom edge with white text on it, or null. The band
 * is the run of rows from the bottom edge that are at least half near-black
 * and either almost all unsaturated or holding near-white text pixels: the
 * WebP encode fringes the text with colour, so a text row falls to about 78%
 * unsaturated. It counts only at 60-160 rows, with solid rows (almost all
 * unsaturated) at its bottom edge and its top, and some near-white text pixel
 * in it: that is what tells it from black art along the bottom edge.
 */
export function detectBanner(img: RgbImage): Box | null {
  const { data, width, height } = img;
  let top = height;
  let sawText = false;
  let edgeSolid = false;
  let topSolid = false;
  for (let y = height - 1; y >= 0; y--) {
    let unsaturated = 0;
    let black = 0;
    let white = 0;
    const row = y * width * 3;
    for (let x = 0; x < width; x++) {
      const i = row + x * 3;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (Math.max(r, g, b) - Math.min(r, g, b) > BANNER_MAX_CHROMA) continue;
      unsaturated++;
      const l = luma(r, g, b);
      if (l < BANNER_BLACK_LUMA) black++;
      else if (l > BANNER_WHITE_LUMA) white++;
    }
    const solid = unsaturated >= width * BANNER_MIN_UNSATURATED;
    if (black < width * BANNER_MIN_BLACK || (!solid && white === 0)) break;
    if (y === height - 1) edgeSolid = solid;
    top = y;
    topSolid = solid;
    if (white > 0) sawText = true;
    if (height - top > BANNER_MAX_ROWS) return null;
  }
  const rows = height - top;
  if (rows < BANNER_MIN_ROWS || !sawText || !edgeSolid || !topSolid) {
    return null;
  }
  return { x: 0, y: top, width, height: rows };
}

/** Fills the box with #000000, in place. */
export function paintBlack(img: RgbImage, box: Box): void {
  for (let y = box.y; y < box.y + box.height; y++) {
    const start = (y * img.width + box.x) * 3;
    img.data.fill(0, start, start + box.width * 3);
  }
}

// ─── Overlay: lettering over a flat gutter ──────────────────────────────────

/** How far left and right of a box a row is read to learn the gutter's colour. */
const GUTTER_MARGIN_PX = 40;
/** A gutter pixel sits within this of the row's mean, per channel. */
const GUTTER_FLAT = 12;
/** Pixels inside the box must be this unsaturated to count as lettering or gutter. */
const GUTTER_MAX_CHROMA = 16;

/**
 * Rows of `box` that run across a flat black or white gutter get that colour
 * painted over the lettering, and the image model is left the rows over art.
 * On the fixture the model kept returning grey letters over a black gutter
 * unchanged, three rounds in a row (issue-2 page 20, #541). A row qualifies
 * when its pixels in the margins beside the box are one unsaturated colour,
 * and every pixel inside the box is unsaturated too (lettering over black or
 * white is grey; art inside the box has colour and the row is skipped).
 * Returns the rows painted, as a box, or null.
 */
export function paintGutterRows(img: RgbImage, box: Box): Box | null {
  const x0 = Math.max(0, box.x - GUTTER_MARGIN_PX);
  const x1 = Math.min(img.width, box.x + box.width + GUTTER_MARGIN_PX);
  let top = -1;
  let bottom = -1;
  for (let y = box.y; y < box.y + box.height; y++) {
    let sum = 0;
    let n = 0;
    const px = (x: number) => (y * img.width + x) * 3;
    for (let x = x0; x < x1; x++) {
      if (x >= box.x && x < box.x + box.width) continue;
      const o = px(x);
      sum += img.data[o]! + img.data[o + 1]! + img.data[o + 2]!;
      n += 3;
    }
    if (n === 0) continue;
    const mean = sum / n;
    if (mean > 40 && mean < 215) continue; // neither black nor white
    let flat = true;
    for (let x = x0; x < x1 && flat; x++) {
      if (x >= box.x && x < box.x + box.width) continue;
      const o = px(x);
      for (let c = 0; c < 3; c++) {
        if (Math.abs(img.data[o + c]! - mean) > GUTTER_FLAT) flat = false;
      }
    }
    if (!flat) continue;
    let unsaturated = true;
    for (let x = box.x; x < box.x + box.width && unsaturated; x++) {
      const o = px(x);
      const r = img.data[o]!;
      const g = img.data[o + 1]!;
      const b = img.data[o + 2]!;
      if (Math.max(r, g, b) - Math.min(r, g, b) > GUTTER_MAX_CHROMA) {
        unsaturated = false;
      }
    }
    if (!unsaturated) continue;
    const v = Math.round(mean);
    img.data.fill(v, px(box.x), px(box.x + box.width));
    if (top < 0) top = y;
    bottom = y;
  }
  if (top < 0) return null;
  return { x: box.x, y: top, width: box.width, height: bottom - top + 1 };
}

// ─── Overlay: detect with a vision call ─────────────────────────────────────

/** A detection wider or taller than this share of the page is a failure. */
const OVERLAY_MAX_WIDTH = 0.6;
const OVERLAY_MAX_HEIGHT = 0.1;
const DETECT_HEIGHT_PX = 1000;

const DETECT_PROMPT = `Find any watermark on this comic book page. A watermark here is a line of translucent, semi-transparent lettering (a website name or similar), usually light grey or white, laid over the artwork so the art shows through it, usually near a corner or an edge of the page. It was added on top of the finished page and is not part of the comic: speech bubbles, captions, sound effects, titles, credits, signatures, page numbers, barcodes, and halftone dots, textures or patterns in the art are not watermarks. Report one only when you can make out its letters.

Return a JSON array with one item per watermark: {"box_2d": [ymin, xmin, ymax, xmax], "label": "<what it looks like>"}, coordinates normalized to 0-1000, the box drawn tight around the watermark's lettering. Return [] when the page has no watermark.`;

/** Gemini's `box_2d` ([ymin, xmin, ymax, xmax], 0-1000) to page pixels. */
export function boxFromNormalized(
  box2d: unknown,
  width: number,
  height: number,
): Box | null {
  if (!Array.isArray(box2d) || box2d.length !== 4) return null;
  const n = box2d.map(Number);
  if (n.some((v) => !Number.isFinite(v))) return null;
  const [ymin, xmin, ymax, xmax] = n as [number, number, number, number];
  const x0 = Math.max(0, Math.floor((Math.min(xmin, xmax) / 1000) * width));
  const x1 = Math.min(width, Math.ceil((Math.max(xmin, xmax) / 1000) * width));
  const y0 = Math.max(0, Math.floor((Math.min(ymin, ymax) / 1000) * height));
  const y1 = Math.min(
    height,
    Math.ceil((Math.max(ymin, ymax) / 1000) * height),
  );
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** True when a detected box is small enough to be a watermark, not a misfire. */
export function isPlausibleOverlay(
  box: Box,
  width: number,
  height: number,
): boolean {
  return (
    box.width <= width * OVERLAY_MAX_WIDTH &&
    box.height <= height * OVERLAY_MAX_HEIGHT
  );
}

function parseDetections(text: string): unknown[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const parsed: unknown = JSON.parse(cleaned || "[]");
  return Array.isArray(parsed) ? parsed : [];
}

/** One GEMINI_MEDIUM call on the page downscaled to ~1000 px tall. */
export async function detectOverlays(
  img: RgbImage,
  meta: LlmCallMeta,
): Promise<{ accepted: Box[]; rejected: Box[] }> {
  const jpeg = await sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 3 },
  })
    .resize({ height: Math.min(DETECT_HEIGHT_PX, img.height) })
    .jpeg({ quality: 85 })
    .toBuffer();
  const response = await generateContentLogged(
    getGeminiClient(),
    {
      model: GEMINI_MEDIUM,
      contents: [
        {
          role: "user",
          parts: [
            { text: DETECT_PROMPT },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: jpeg.toString("base64"),
              },
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    },
    meta,
  );
  const accepted: Box[] = [];
  const rejected: Box[] = [];
  for (const item of parseDetections(response.text ?? "")) {
    const box = boxFromNormalized(
      (item as { box_2d?: unknown } | null)?.box_2d,
      img.width,
      img.height,
    );
    if (!box) continue;
    (isPlausibleOverlay(box, img.width, img.height) ? accepted : rejected).push(
      box,
    );
  }
  return { accepted, rejected };
}

// ─── Overlay: edit a crop, copy back through a change mask ─────────────────

/** Padding around a detected box; the edit may only change pixels inside. */
export const OVERLAY_GROW_PX = 16;
const MASK_BLUR_SIGMA = 2;
const MASK_DIFF = 12;
const MASK_DILATE_PX = 3;
/**
 * A mask over more of the grown box than this means the edit redrew the
 * art. The lettering fills most of its box, and at MASK_DIFF 12 the mask
 * took 65% to 75% of it on the two fixture pages the lead ran (#541).
 */
const MASK_MAX_SHARE = 0.9;
/**
 * Rounds per page: each round edits every detected box, then the page is
 * detected again; a round runs only while lettering is still found. The
 * model is stochastic: on the fixture it returned no image, an unchanged
 * crop, or a half-cleaned one about as often as a clean one.
 */
const OVERLAY_ROUNDS = 3;

/** Aspect ratios the image model accepts, as width / height. */
const ASPECT_RATIOS: Array<[string, number]> = [
  ["1:1", 1],
  ["2:3", 2 / 3],
  ["3:2", 3 / 2],
  ["3:4", 3 / 4],
  ["4:3", 4 / 3],
  ["4:5", 4 / 5],
  ["5:4", 5 / 4],
  ["9:16", 9 / 16],
  ["16:9", 16 / 9],
  ["21:9", 21 / 9],
];

/** A crop of `w` x `h` centred on `inner`, shifted to stay on the page. */
function placeCrop(
  inner: Box,
  w: number,
  h: number,
  width: number,
  height: number,
): Box {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  const x = Math.min(Math.max(0, Math.round(cx - w / 2)), width - w);
  const y = Math.min(Math.max(0, Math.round(cy - h / 2)), height - h);
  return { x, y, width: w, height: h };
}

const EDIT_PROMPT = `This is a crop from a comic book page. A line of semi-transparent light grey lettering was accidentally laid over the artwork. Paint the lettering out and restore the artwork underneath it, continuing the lines, colors and shading around it. Change nothing else: keep every other line, color, shape and texture, and the framing and size, exactly as they are. Return the edited image.`;

export function growBox(box: Box, pad: number, width: number, height: number) {
  const x0 = Math.max(0, box.x - pad);
  const y0 = Math.max(0, box.y - pad);
  const x1 = Math.min(width, box.x + box.width + pad);
  const y1 = Math.min(height, box.y + box.height + pad);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The smallest crop at a supported aspect ratio that contains `inner`,
 * centred on it and shifted to stay on the page. Null when none fits. The
 * model returns its own size (1584x672 for 21:9) and the result is resized
 * back; a crop at that native size was tried on 2026-10-06 and the model
 * then left the lettering mostly in place, so the small crop stays (#541).
 */
export function cropForAspect(
  inner: Box,
  width: number,
  height: number,
): { box: Box; aspectRatio: string } | null {
  let best: { box: Box; aspectRatio: string; area: number } | null = null;
  for (const [aspectRatio, r] of ASPECT_RATIOS) {
    const w = Math.ceil(Math.max(inner.width, inner.height * r));
    const h = Math.ceil(w / r);
    if (w > width || h > height) continue;
    if (!best || w * h < best.area) {
      best = {
        box: placeCrop(inner, w, h, width, height),
        aspectRatio,
        area: w * h,
      };
    }
  }
  if (!best) return null;
  return { box: best.box, aspectRatio: best.aspectRatio };
}

function cropRgb(img: RgbImage, box: Box): RgbImage {
  const data = Buffer.alloc(box.width * box.height * 3);
  for (let y = 0; y < box.height; y++) {
    const src = ((box.y + y) * img.width + box.x) * 3;
    img.data.copy(data, y * box.width * 3, src, src + box.width * 3);
  }
  return { data, width: box.width, height: box.height };
}

async function blurRgb(img: RgbImage): Promise<Buffer> {
  return sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 3 },
  })
    .blur(MASK_BLUR_SIGMA)
    .raw()
    .toBuffer();
}

/** Square dilation by `r`, done as a horizontal then a vertical pass. */
function dilate(mask: Uint8Array, w: number, h: number, r: number) {
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dx = Math.max(0, x - r); dx <= Math.min(w - 1, x + r); dx++) {
        tmp[y * w + dx] = 1;
      }
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!tmp[y * w + x]) continue;
      for (let dy = Math.max(0, y - r); dy <= Math.min(h - 1, y + r); dy++) {
        out[dy * w + x] = 1;
      }
    }
  }
  return out;
}

/**
 * Where the edit changed the crop: both blurred with sigma 2, any channel
 * moved by more than 12 (24 left the faint edges of the lettering as a
 * ghost: the lead's template score on the fixed page stayed at 0.21
 * against 0.001 for a clean page), dilated by 3 px, cleared outside `keep` (crop
 * coordinates).
 */
export async function buildChangeMask(
  before: RgbImage,
  after: RgbImage,
  keep: Box,
): Promise<Uint8Array> {
  const [a, b] = await Promise.all([blurRgb(before), blurRgb(after)]);
  const { width: w, height: h } = before;
  const raw = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 3;
    if (
      Math.abs(a[i]! - b[i]!) > MASK_DIFF ||
      Math.abs(a[i + 1]! - b[i + 1]!) > MASK_DIFF ||
      Math.abs(a[i + 2]! - b[i + 2]!) > MASK_DIFF
    ) {
      raw[p] = 1;
    }
  }
  const mask = dilate(raw, w, h, MASK_DILATE_PX);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside =
        x >= keep.x &&
        x < keep.x + keep.width &&
        y >= keep.y &&
        y < keep.y + keep.height;
      if (!inside) mask[y * w + x] = 0;
    }
  }
  return mask;
}

type ImageResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{ inlineData?: { data?: string }; text?: string }>;
    };
  }>;
  promptFeedback?: { blockReason?: string };
};

function imageFromResponse(response: ImageResponse): Buffer | null {
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data)
      return Buffer.from(part.inlineData.data, "base64");
  }
  return null;
}

/** Why a response carried no image, for the log and the report. */
function noImageReason(response: ImageResponse): string {
  const c = response.candidates?.[0];
  const text = (c?.content?.parts ?? [])
    .map((p) => p.text?.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 200);
  const bits = [
    c?.finishReason && `finishReason ${c.finishReason}`,
    response.promptFeedback?.blockReason &&
      `blockReason ${response.promptFeedback.blockReason}`,
    text && `text: ${JSON.stringify(text)}`,
  ].filter(Boolean);
  return `the model returned no image${bits.length ? ` (${bits.join("; ")})` : ""}`;
}

type OverlayOutcome =
  | { ok: true; box: Box; crop: Box; mask: Uint8Array; edited: RgbImage }
  | { ok: false; box: Box; reason: string };

/** One image edit on the crop around `box`; never touches `img`. */
async function editOverlay(
  img: RgbImage,
  box: Box,
  meta: LlmCallMeta,
): Promise<OverlayOutcome> {
  const grown = growBox(box, OVERLAY_GROW_PX, img.width, img.height);
  const fit = cropForAspect(grown, img.width, img.height);
  if (!fit) return { ok: false, box: grown, reason: "no crop fits the page" };
  const before = cropRgb(img, fit.box);
  const png = await sharp(before.data, {
    raw: { width: before.width, height: before.height, channels: 3 },
  })
    .png()
    .toBuffer();
  const response = await generateContentLogged(
    getGeminiClient(),
    {
      model: GEMINI_IMAGE_EDIT,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "image/png",
                data: png.toString("base64"),
              },
            },
            { text: EDIT_PROMPT },
          ],
        },
      ],
      config: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: fit.aspectRatio },
      },
    },
    meta,
  );
  const out = imageFromResponse(response);
  if (!out) return { ok: false, box: grown, reason: noImageReason(response) };
  const outMeta = await sharp(out).metadata();
  console.log(
    `[page-watermark] edit returned ${outMeta.width}x${outMeta.height} for a ${fit.box.width}x${fit.box.height} crop (${fit.aspectRatio})`,
  );
  const edited = await decodeRgb(
    await sharp(out)
      .resize(fit.box.width, fit.box.height, { fit: "fill" })
      .png()
      .toBuffer(),
  );
  const keep = {
    x: grown.x - fit.box.x,
    y: grown.y - fit.box.y,
    width: grown.width,
    height: grown.height,
  };
  const mask = await buildChangeMask(before, edited, keep);
  let set = 0;
  for (const v of mask) set += v;
  const share = set / (grown.width * grown.height);
  if (share > MASK_MAX_SHARE) {
    return {
      ok: false,
      box: grown,
      reason: `the edit changed ${(share * 100).toFixed(0)}% of the box (limit ${MASK_MAX_SHARE * 100}%)`,
    };
  }
  // A small mask is not rejected here: a faint remnant changes little, and
  // the re-detection after the round is what decides whether lettering is
  // left (an 8% floor turned two real edits away on the fixture).
  return { ok: true, box: grown, crop: fit.box, mask, edited };
}

/** Copies the edit into `img` where the crop-sized mask is set. */
function compositeMasked(
  img: RgbImage,
  crop: Box,
  edited: RgbImage,
  mask: Uint8Array,
  changed: Uint8Array,
) {
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      if (!mask[y * crop.width + x]) continue;
      const p = (crop.y + y) * img.width + crop.x + x;
      edited.data.copy(
        img.data,
        p * 3,
        (y * crop.width + x) * 3,
        (y * crop.width + x) * 3 + 3,
      );
      changed[p] = 1;
    }
  }
}

/**
 * Cleans one page: paints a banner band black, then edits away any overlay
 * the vision call finds on the banner-painted page. Same width and height
 * out as in. A failed overlay edit leaves the page as it was there and is
 * listed in `failures`. Under DRY_RUN the overlay calls are skipped.
 */
export async function cleanPageWatermarks(args: {
  buffer: Buffer;
  bookId: string;
  issueId: string;
  pageNumber: number;
}): Promise<CleanResult> {
  const { buffer, bookId, issueId, pageNumber } = args;
  const img = await decodeRgb(buffer);
  const fixes: WatermarkFix[] = [];
  const failures: WatermarkFailure[] = [];
  const changed = new Uint8Array(img.width * img.height);

  const banner = detectBanner(img);
  if (banner) {
    paintBlack(img, banner);
    changed.fill(1, banner.y * img.width, img.width * img.height);
    fixes.push({ kind: "banner", box: banner });
  }

  if (!isDryRun()) {
    const where = { bookId, issueId, pageNumber };
    try {
      const detectMeta = { step: "page-watermark-detect", ...where };
      const editMeta = { step: "page-watermark-edit", ...where };
      let { accepted, rejected } = await detectOverlays(img, detectMeta);
      for (const box of rejected) {
        const reason = `detection too large to be a watermark (${box.width}x${box.height} on ${img.width}x${img.height})`;
        console.warn(
          `[page-watermark] ${bookId}/${issueId} p${pageNumber}: ${reason}`,
        );
        failures.push({ kind: "overlay", reason, box });
      }
      for (let round = 1; accepted.length > 0; round++) {
        for (const box of accepted) {
          const gutter = paintGutterRows(img, box);
          if (gutter) {
            for (let y = gutter.y; y < gutter.y + gutter.height; y++) {
              changed.fill(
                1,
                y * img.width + gutter.x,
                y * img.width + gutter.x + gutter.width,
              );
            }
            fixes.push({ kind: "overlay", box: gutter });
          }
          const outcome = await editOverlay(img, box, editMeta);
          if (!outcome.ok) {
            console.warn(
              `[page-watermark] ${bookId}/${issueId} p${pageNumber} round ${round}: ${outcome.reason}`,
            );
            continue;
          }
          compositeMasked(
            img,
            outcome.crop,
            outcome.edited,
            outcome.mask,
            changed,
          );
          // One fix per round, so the report's fixed region covers every
          // box the rounds edited, not only the first round's.
          fixes.push({ kind: "overlay", box: outcome.box });
        }
        // The page as it now is, seen by the detector again: a clean result
        // ends the rounds, lettering that is still there gets another one.
        ({ accepted } = await detectOverlays(img, detectMeta));
        if (accepted.length === 0) break;
        if (round >= OVERLAY_ROUNDS) {
          const reason = `lettering still detected after ${round} rounds`;
          console.warn(
            `[page-watermark] ${bookId}/${issueId} p${pageNumber}: ${reason}`,
          );
          failures.push({ kind: "overlay", reason, box: accepted[0] });
          break;
        }
      }
    } catch (err) {
      const reason = `overlay call failed: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(
        `[page-watermark] ${bookId}/${issueId} p${pageNumber}: ${reason}`,
      );
      failures.push({ kind: "overlay", reason });
    }
  }

  if (fixes.length === 0) return { buffer, fixes, failures };
  const png = await sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 3 },
  })
    .png({ compressionLevel: 1 })
    .toBuffer();
  return {
    buffer: png,
    fixes,
    failures,
    changedMask: { width: img.width, height: img.height, data: changed },
  };
}
