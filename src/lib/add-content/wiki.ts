/**
 * Issue wiki titles and covers for the add-content flow (#792).
 *
 * `books.wiki_title_template` comes in two shapes: `MMPR/TMNT_III_Issue_{number}`
 * and `/wiki/DC_X_Sonic_the_Hedgehog_Issue_{number}` (add-book asks Gemini for a
 * "URL path pattern"). Everything here goes through `wikiPageTitle`, which takes
 * both. Client-safe: no server imports.
 */

import { isPublicHttpUrl } from "./public-url";

/** The page title, underscores kept: `DC_X_Sonic_the_Hedgehog_Issue_1`. */
export function wikiPageTitle(template: string, issueNumber: number): string {
  return template
    .trim()
    .replace(/^\/?wiki\//i, "")
    .replace(/^\/+/, "")
    .replaceAll("{number}", String(issueNumber));
}

/** The title as words, for a search query: `DC X Sonic the Hedgehog Issue 1`. */
export function wikiTitleWords(template: string, issueNumber: number): string {
  return wikiPageTitle(template, issueNumber)
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wikiOrigin(wikiHost: string): string {
  const host = wikiHost.trim().replace(/\/+$/, "");
  return host.startsWith("http") ? host : `https://${host}`;
}

export function wikiPageUrl(
  wikiHost: string,
  template: string,
  issueNumber: number,
): string {
  return `${wikiOrigin(wikiHost)}/wiki/${wikiPageTitle(template, issueNumber)}`;
}

interface PageImagesResponse {
  query?: {
    pages?: Record<string, { missing?: string; original?: { source: string } }>;
  };
}

/** The issue page's lead image (MediaWiki `pageimages`), or null. */
export async function fetchWikiCoverUrl(
  wikiHost: string,
  pageTitle: string,
): Promise<string | null> {
  const params = new URLSearchParams({
    action: "query",
    prop: "pageimages",
    piprop: "original",
    titles: pageTitle,
    redirects: "1",
    format: "json",
  });
  const api = `${wikiOrigin(wikiHost)}/api.php?${params}`;
  if (!isPublicHttpUrl(api)) return null;
  try {
    const res = await fetch(api);
    if (!res.ok) return null;
    const data = (await res.json()) as PageImagesResponse;
    const pages = Object.values(data.query?.pages ?? {});
    return pages.find((p) => p.original?.source)?.original?.source ?? null;
  } catch {
    return null;
  }
}
