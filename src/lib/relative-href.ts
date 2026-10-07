/**
 * The gate URL is stored absolute to whatever host wrote it (localhost in a
 * dev run, the Vercel host in prod). Keep the path, query and hash, drop the
 * host, so the link opens on the host the page is served from.
 */
export function toRelativeHref(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}
