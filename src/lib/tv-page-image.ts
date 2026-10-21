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

/** Unpinned copies to keep: a spread plus both neighbors is six. */
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

/**
 * A page's TV copy: the URL to render, and the original image's natural
 * size. On failure the URL is the original src and the size is 0 x 0.
 */
export interface TvPageImage {
  url: string;
  width: number;
  height: number;
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

async function downscale(src: string): Promise<TvPageImage> {
  const res = await fetch(src, { mode: "cors" });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const full = await createImageBitmap(await res.blob());
  // Each bitmap is closed once: a second close() throws on the TV.
  let small: ImageBitmap | null = null;
  try {
    const { width, height } = full;
    const size = tvTargetSize(width, height);
    if (size.width !== width || size.height !== height) {
      small = await createImageBitmap(full, {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: "high",
      });
    }
    const blob = await encodeJpeg(small ?? full);
    return { url: URL.createObjectURL(blob), width, height };
  } finally {
    small?.close();
    full.close();
  }
}

interface Job {
  /** False once something on screen asked for it: it then runs first. */
  prefetch: boolean;
  run: () => Promise<void>;
}

interface Entry {
  promise: Promise<TvPageImage>;
  /** Set once the copy is made (or failed). */
  info?: TvPageImage;
  /** Set until the job starts. */
  job?: Job;
  /** Mounted images using the URL; a pinned entry is never revoked. */
  pins: number;
}

const cache = new Map<string, Entry>();

// One downscale at a time, so a spread turn never decodes four full pages
// at once. On-screen requests run before prefetches.
const queue: Job[] = [];
let running = false;

function pump(): void {
  if (running || queue.length === 0) return;
  const onScreen = queue.findIndex((job) => !job.prefetch);
  const [job] = queue.splice(onScreen >= 0 ? onScreen : 0, 1);
  if (!job) return;
  running = true;
  void job.run().finally(() => {
    running = false;
    pump();
  });
}

function evict(keep?: string): void {
  let unpinned = 0;
  for (const entry of cache.values()) {
    if (entry.pins === 0 && entry.info) unpinned++;
  }
  // Oldest first; pinned and in-flight entries stay.
  for (const [src, entry] of cache) {
    if (unpinned <= CACHE_LIMIT) return;
    if (entry.pins > 0 || !entry.info || src === keep) continue;
    cache.delete(src);
    unpinned--;
    if (entry.info.url !== src) URL.revokeObjectURL(entry.info.url);
  }
}

function request(src: string, prefetch: boolean): Entry {
  const hit = cache.get(src);
  if (hit) {
    // Most recent last, so eviction drops the oldest page first.
    cache.delete(src);
    cache.set(src, hit);
    if (!prefetch && hit.job) hit.job.prefetch = false;
    return hit;
  }
  let resolve: (info: TvPageImage) => void = () => undefined;
  const entry: Entry = {
    promise: new Promise((r) => (resolve = r)),
    pins: 0,
  };
  const job: Job = {
    prefetch,
    run: async () => {
      entry.job = undefined;
      const info = await downscale(src).catch(() => ({
        url: src,
        width: 0,
        height: 0,
      }));
      entry.info = info;
      resolve(info);
      evict(src);
    },
  };
  entry.job = job;
  cache.set(src, entry);
  queue.push(job);
  pump();
  return entry;
}

/** The TV copy of a page on screen, made ahead of any prefetch. */
export function tvPageImageInfo(src: string): Promise<TvPageImage> {
  return request(src, false).promise;
}

/**
 * Asks for the TV copy of a page on screen and keeps its URL alive until
 * the returned release runs.
 */
export function retainTvPageImage(src: string): {
  promise: Promise<TvPageImage>;
  release: () => void;
} {
  const entry = request(src, false);
  entry.pins++;
  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry.pins--;
      // After the commit: a remount pins the same entry again first.
      queueMicrotask(() => evict());
    },
  };
}

/**
 * Queues the TV copies of nearby pages behind anything on screen. The
 * returned cancel drops those not started yet.
 */
export function prefetchTvPageImages(srcs: string[]): () => void {
  for (const src of srcs) request(src, true);
  return () => {
    for (const src of srcs) {
      const entry = cache.get(src);
      const job = entry?.job;
      if (!job?.prefetch) continue;
      const at = queue.indexOf(job);
      if (at < 0) continue;
      queue.splice(at, 1);
      cache.delete(src);
    }
  };
}

/** The TV copy's URL if it is already made, else null. Never starts work. */
export function peekTvPageImageUrl(src: string): string | null {
  return cache.get(src)?.info?.url ?? null;
}
