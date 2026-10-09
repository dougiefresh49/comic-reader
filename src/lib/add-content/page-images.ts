/**
 * Page images from a source page's HTML, no browser and no Gemini (#792).
 * Client-safe; the browser fallback lives in `collect-pages.ts`.
 */

import { assertPublicHttpUrl } from "~/lib/add-content/public-url";

/** Fewer images than this means the page is not a whole issue. */
export const MIN_PAGE_IMAGES = 3;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

/**
 * GET a page as a browser would, following up to 5 redirects by hand so each
 * hop passes `assertPublicHttpUrl`. Returns where it landed; the caller decides
 * whether that is still the confirmed issue.
 */
export async function fetchHtml(
  url: string,
): Promise<{ html: string; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    assertPublicHttpUrl(current);
    const res = await fetch(current, {
      headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html" },
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${current}`);
    return { html: await res.text(), finalUrl: current };
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

function attr(tag: string, name: string): string | null {
  // `\s` before the name keeps `src` from matching inside `data-src`.
  const m = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").replace(/&amp;|&#0?38;/g, "&").trim();
}

/** WordPress "Madara" reader sites mark every page image with this class. */
const READER_IMG_CLASS = /\bwp-manga-chapter-img\b/;
const UI_IMAGE =
  /logo|icon|avatar|banner|sprite|placeholder|dflazy|loading|thumb|emoji|badge|button|\/ads?\//i;

/** Longest run of consecutive numbers among the files' trailing numbers. */
function pageNumber(url: string): number | null {
  const file = new URL(url).pathname.split("/").pop() ?? "";
  const m = /(\d+)\D*$/.exec(file.replace(/\.[a-z0-9]+$/i, ""));
  return m ? Number(m[1]) : null;
}

/** The URLs whose file numbers form the longest consecutive run. */
function pageNumberRun(urls: string[]): string[] {
  const nums = new Set(
    urls.map(pageNumber).filter((n): n is number => n !== null),
  );
  let start = 0;
  let best = 0;
  for (const n of nums) {
    if (nums.has(n - 1)) continue;
    let len = 1;
    while (nums.has(n + len)) len++;
    if (len > best) [start, best] = [n, len];
  }
  return urls.filter((u) => {
    const n = pageNumber(u);
    return n !== null && n >= start && n < start + best;
  });
}

/**
 * Page image URLs in document order. Lazy-load attributes win over `src`
 * (which often holds a placeholder). When the page uses the reader class, only
 * those images count. Otherwise UI-looking images are dropped and the largest
 * same-directory group counts only if at least MIN_PAGE_IMAGES of its file
 * names run in page-number order; without that evidence it returns none, so
 * the browser path or the short-count stop takes over.
 */
export function extractPageImageUrls(html: string, pageUrl: string): string[] {
  const images: Array<{ url: string; reader: boolean; ui: boolean }> = [];
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const raw =
      attr(tag, "data-lazy-src") ?? attr(tag, "data-src") ?? attr(tag, "src");
    if (!raw || raw.startsWith("data:")) continue;
    let url: string;
    try {
      url = new URL(raw, pageUrl).href;
    } catch {
      continue;
    }
    const cls = attr(tag, "class") ?? "";
    const width = Number(attr(tag, "width"));
    images.push({
      url,
      reader: READER_IMG_CLASS.test(cls),
      ui:
        UI_IMAGE.test(url) ||
        UI_IMAGE.test(cls) ||
        /\.svg(\?|$)/i.test(url) ||
        (width > 0 && width < 300),
    });
  }

  let picked = images.filter((i) => i.reader);
  if (picked.length === 0) {
    const groups = new Map<string, typeof images>();
    for (const img of images.filter((i) => !i.ui)) {
      const dir = img.url.slice(0, img.url.lastIndexOf("/"));
      groups.set(dir, [...(groups.get(dir) ?? []), img]);
    }
    for (const group of groups.values()) {
      const run = new Set(pageNumberRun(group.map((i) => i.url)));
      if (run.size > picked.length && run.size >= MIN_PAGE_IMAGES) {
        picked = group.filter((i) => run.has(i.url));
      }
    }
  }
  return [...new Set(picked.map((i) => i.url))];
}

/** `og:site_name` up to its first " - " or " | ", else the host. */
export function siteNameFrom(html: string | null, url: string): string {
  const meta = html
    ? /<meta[^>]+property=["']og:site_name["'][^>]*>/i.exec(html)?.[0]
    : undefined;
  const [name] = ((meta && attr(meta, "content")) ?? "")
    .split(/\s[-|–]\s/)
    .map((s) => s.trim())
    .filter(Boolean);
  return name ?? new URL(url).hostname.replace(/^www\./, "");
}

// Pagination and reading-mode params (`readType`, set by `#selectReadType`).
const PAGE_PARAMS = new Set(["page", "p", "pg", "readtype"]);
const PAGE_SUFFIX = /^\/(?:page\/)?\d+$/i;

/**
 * True when `candidate` is the confirmed issue page or its own pagination:
 * same origin; every query param of the confirmed URL kept with the same value,
 * plus at most `page`/`p`/`pg`; and the confirmed path, or it followed by a
 * page number (`/2`, `/page/2`). `issue-1` never matches `issue-10`,
 * `issue-2` or `?issue=2`.
 */
export function isSameIssuePage(candidate: string, confirmed: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(candidate, confirmed);
    b = new URL(confirmed);
  } catch {
    return false;
  }
  if (a.origin !== b.origin) return false;
  const values = (u: URL, k: string) =>
    u.searchParams.getAll(k).sort().join("\0");
  for (const k of new Set([
    ...a.searchParams.keys(),
    ...b.searchParams.keys(),
  ])) {
    if (PAGE_PARAMS.has(k.toLowerCase())) continue;
    if (values(a, k) !== values(b, k)) return false;
  }
  const base = b.pathname.replace(/\/+$/, "");
  const path = a.pathname.replace(/\/+$/, "");
  return (
    path === base ||
    (path.startsWith(`${base}/`) && PAGE_SUFFIX.test(path.slice(base.length)))
  );
}
