import "server-only";
import sharp from "sharp";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { pageStoragePath } from "~/lib/storage";
import { cleanPageWatermarks, type WatermarkFix } from "~/lib/page-watermark";

const WEBP_BUCKET = "comic-pages";
export const WEBP_QUALITY = 82;

/**
 * How every stored page is encoded, scripts included (#541). smartSubsample
 * keeps re-encode noise on saturated edges under the 32 the watermark diff
 * allows: without it 12 of 76 stored pages moved a pixel by up to 42.
 */
export function encodePageWebp(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .webp({ quality: WEBP_QUALITY, smartSubsample: true })
    .toBuffer();
}

/**
 * Remove the source watermark (#541), convert the page to WebP, upload to the
 * flat comic-pages key, and upsert the matching `pages` row. Throws on any
 * storage or DB error, and when the clean changed the image's size.
 */
export async function storePageImage(args: {
  bookId: string;
  issueId: string;
  pageNumber: number;
  buffer: Buffer;
}): Promise<{
  width: number;
  height: number;
  storagePath: string;
  fixes: WatermarkFix[];
}> {
  const { bookId, issueId, pageNumber } = args;
  const storagePath = pageStoragePath(bookId, issueId, pageNumber);

  const metadata = await sharp(args.buffer).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  const { buffer, fixes } = await cleanPageWatermarks(args);
  if (fixes.length > 0) {
    const cleaned = await sharp(buffer).metadata();
    if (cleaned.width !== width || cleaned.height !== height) {
      throw new Error(
        `watermark clean changed ${storagePath} from ${width}x${height} to ${cleaned.width}x${cleaned.height}`,
      );
    }
  }

  const webpBuffer = await encodePageWebp(buffer);

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
      width,
      height,
      storage_path: storagePath,
    },
    { onConflict: "book_id,issue_id,number" },
  );
  if (rowError) {
    throw new Error(
      `pages upsert failed for ${bookId}/${issueId} page ${pageNumber}: ${rowError.message}`,
    );
  }

  return { width, height, storagePath, fixes };
}
