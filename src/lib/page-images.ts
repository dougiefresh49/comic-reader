import "server-only";
import sharp from "sharp";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { pageStoragePath } from "~/lib/storage";
import {
  cleanPageWatermarks,
  type WatermarkFailure,
  type WatermarkFix,
} from "~/lib/page-watermark";

const WEBP_BUCKET = "comic-pages";
export const WEBP_QUALITY = 82;
/**
 * The longest edge a stored page may have, in pixels (#943). A larger page is
 * scaled down to it, aspect kept; a smaller one is stored at its own size.
 */
export const PAGE_MAX_EDGE = 2000;

/**
 * How every stored page is encoded, scripts included (#541). smartSubsample
 * keeps re-encode noise on saturated edges under the 32 the watermark diff
 * allows: without it 12 of 76 stored pages moved a pixel by up to 42. It keeps
 * the input's size, because `scripts/fix-page-watermarks.ts` diffs its output
 * pixel by pixel against the input; the size cap is `capPageSize`, run first.
 */
export function encodePageWebp(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .webp({ quality: WEBP_QUALITY, smartSubsample: true })
    .toBuffer();
}

/**
 * Scales a page down so its long edge is at most PAGE_MAX_EDGE (#943), with
 * sharp's default lanczos3. A page already within the cap comes back as the
 * same buffer. A scaled page comes back as an uncompressed PNG, so the only
 * lossy step stays `encodePageWebp`. `width` and `height` are the returned
 * image's.
 */
export async function capPageSize(
  buffer: Buffer,
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const { width = 0, height = 0 } = await sharp(buffer).metadata();
  if (Math.max(width, height) <= PAGE_MAX_EDGE) {
    return { buffer, width, height };
  }
  const { data, info } = await sharp(buffer)
    .resize({
      width: PAGE_MAX_EDGE,
      height: PAGE_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 0 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

/**
 * Remove the source watermark (#541), scale the page down to PAGE_MAX_EDGE
 * (#943), convert it to WebP, upload to the flat comic-pages key, and upsert
 * the matching `pages` row with the stored size. Throws on any storage or DB
 * error, and when the clean changed the image's size. With
 * `rejectCleanFailures`, also throws before any write when the clean left a
 * watermark (a failed Gemini call included), so a page that is already clean
 * is never overwritten by one that is not (#943).
 */
export async function storePageImage(args: {
  bookId: string;
  issueId: string;
  pageNumber: number;
  buffer: Buffer;
  rejectCleanFailures?: boolean;
}): Promise<{
  /** The stored page's size, after the cap. */
  width: number;
  height: number;
  storagePath: string;
  fixes: WatermarkFix[];
  /** Watermarks left on the stored page, with why (#541). */
  failures: WatermarkFailure[];
}> {
  const { bookId, issueId, pageNumber } = args;
  const storagePath = pageStoragePath(bookId, issueId, pageNumber);

  const metadata = await sharp(args.buffer).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  const { buffer, fixes, failures } = await cleanPageWatermarks(args);
  if (args.rejectCleanFailures && failures.length > 0) {
    throw new Error(
      `watermark clean left ${failures.length} on ${storagePath}, nothing stored: ${failures.map((f) => f.reason).join("; ")}`,
    );
  }
  if (fixes.length > 0) {
    const cleaned = await sharp(buffer).metadata();
    if (cleaned.width !== width || cleaned.height !== height) {
      throw new Error(
        `watermark clean changed ${storagePath} from ${width}x${height} to ${cleaned.width}x${cleaned.height}`,
      );
    }
  }

  const stored = await capPageSize(buffer);
  const webpBuffer = await encodePageWebp(stored.buffer);

  const { error: uploadError } = await supabaseAdmin.storage
    .from(WEBP_BUCKET)
    .upload(storagePath, webpBuffer, {
      contentType: "image/webp",
      upsert: true,
    });
  if (uploadError) {
    throw new Error(
      `WebP upload failed for ${storagePath}: ${uploadError.message}`,
    );
  }

  const { error: rowError } = await supabaseAdmin.from("pages").upsert(
    {
      book_id: bookId,
      issue_id: issueId,
      number: pageNumber,
      width: stored.width,
      height: stored.height,
      storage_path: storagePath,
    },
    { onConflict: "book_id,issue_id,number" },
  );
  if (rowError) {
    throw new Error(
      `pages upsert failed for ${bookId}/${issueId} page ${pageNumber}: ${rowError.message}`,
    );
  }

  return {
    width: stored.width,
    height: stored.height,
    storagePath,
    fixes,
    failures,
  };
}
