function storageBase(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function pageImageUrl(
  bookId: string,
  issueId: string,
  pageNum: number,
): string {
  const padded = String(pageNum).padStart(2, "0");
  return `${storageBase()}/storage/v1/object/public/comic-pages/${bookId}/${issueId}/page-${padded}.webp`;
}

export function audioUrl(
  bookId: string,
  issueId: string,
  audioStoragePath: string,
): string {
  return `${storageBase()}/storage/v1/object/public/comic-audio/${bookId}/${issueId}/${audioStoragePath}`;
}
