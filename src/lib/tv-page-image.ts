/**
 * TV mode page images (#962). The Samsung TV re-decodes a full-size page
 * WebP on every panel move (about 1.2 s each); a copy with its long edge at
 * 2448 px stays in the TV's decode cache. So in TV mode each page image is
 * fetched once, downscaled, re-encoded as JPEG and served from a blob URL.
 * Off TV nothing here runs.
 */

/** The long edge the TV's decode cache held on every panel move (#962). */
export const TV_PAGE_MAX_EDGE = 2448;

const JPEG_QUALITY = 0.9;

/** How many page URLs to keep: a spread plus both neighbors is six. */
const CACHE_LIMIT = 8;

/**
 * The size to draw a `width` x `height` page at on the TV: scaled so the
 * long edge is at most TV_PAGE_MAX_EDGE, never scaled up.
 */
export function tvTargetSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= TV_PAGE_MAX_EDGE) return { width, height };
  const scale = TV_PAGE_MAX_EDGE / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function encodeJpeg(bitmap: ImageBitmap): Promise<Blob> {
  const { width, height } = bitmap;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0);
    return canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      JPEG_QUALITY,
    ),
  );
}

async function downscale(src: string): Promise<string> {
  const res = await fetch(src, { mode: "cors" });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const full = await createImageBitmap(await res.blob());
  const size = tvTargetSize(full.width, full.height);
  let bitmap = full;
  try {
    if (size.width !== full.width || size.height !== full.height) {
      bitmap = await createImageBitmap(full, {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: "high",
      });
    }
    return URL.createObjectURL(await encodeJpeg(bitmap));
  } finally {
    bitmap.close();
    full.close();
  }
}

interface Entry {
  promise: Promise<string>;
  /** Set once the promise settles: the blob URL, or `src` on failure. */
  url?: string;
}

const cache = new Map<string, Entry>();

function evict(): void {
  // Oldest first; an in-flight entry stays until it settles.
  for (const [src, entry] of cache) {
    if (cache.size <= CACHE_LIMIT) return;
    if (entry.url === undefined) continue;
    cache.delete(src);
    if (entry.url !== src) URL.revokeObjectURL(entry.url);
  }
}

/**
 * The TV copy of a page image: a blob URL of the downscaled JPEG, or `src`
 * itself when anything fails. One fetch per src; the 8 most recent are kept.
 */
export function tvPageImageUrl(src: string): Promise<string> {
  const hit = cache.get(src);
  if (hit) {
    // Most recent last, so eviction drops the oldest page first.
    cache.delete(src);
    cache.set(src, hit);
    return hit.promise;
  }
  const entry: Entry = {
    promise: downscale(src)
      .catch(() => src)
      .then((url) => {
        entry.url = url;
        evict();
        return url;
      }),
  };
  cache.set(src, entry);
  evict();
  return entry.promise;
}

/** The TV copy's URL if it is already made, else null. Never starts work. */
export function peekTvPageImageUrl(src: string): string | null {
  return cache.get(src)?.url ?? null;
}
