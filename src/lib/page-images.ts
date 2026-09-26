import "server-only";
import sharp from "sharp";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { pageStoragePath } from "~/lib/storage";

const WEBP_BUCKET = "comic-pages";
const WEBP_QUALITY = 82;

/**
 * Convert a page image to WebP, upload to the flat comic-pages key, and upsert
 * the matching `pages` row. Throws on any storage or DB error.
 */
export async function storePageImage(args: {
  bookId: string;
  issueId: string;
  pageNumber: number;
  buffer: Buffer;
}): Promise<{ width: number; height: number; storagePath: string }> {
  const { bookId, issueId, pageNumber, buffer } = args;
  const storagePath = pageStoragePath(bookId, issueId, pageNumber);

  const [webpBuffer, metadata] = await Promise.all([
    sharp(buffer).webp({ quality: WEBP_QUALITY }).toBuffer(),
    sharp(buffer).metadata(),
  ]);

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

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

  return { width, height, storagePath };
}
