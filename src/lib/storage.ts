function storageBase(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Canonical object key in the comic-pages bucket: `{book}/{issue}/page-NN.webp`. */
export function pageStoragePath(
  bookId: string,
  issueId: string,
  pageNumber: number,
): string {
  const padded = String(pageNumber).padStart(2, "0");
  return `${bookId}/${issueId}/page-${padded}.webp`;
}

export function pageImageUrl(
  bookId: string,
  issueId: string,
  pageNum: number,
): string {
  return `${storageBase()}/storage/v1/object/public/comic-pages/${pageStoragePath(bookId, issueId, pageNum)}`;
}

export function audioUrl(
  bookId: string,
  issueId: string,
  audioStoragePath: string,
): string {
  return `${storageBase()}/storage/v1/object/public/comic-audio/${bookId}/${issueId}/${audioStoragePath}`;
}
