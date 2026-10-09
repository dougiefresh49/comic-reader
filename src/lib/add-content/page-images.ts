/**
 * Page images from a source page's HTML, no browser and no Gemini (#792).
 * Client-safe; the browser fallback lives in `collect-pages.ts`.
 */

/** Fewer images than this means the page is not a whole issue. */
export const MIN_PAGE_IMAGES = 3;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

export async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
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

/**
 * Page image URLs in document order. Lazy-load attributes win over `src`
 * (which often holds a placeholder). When the page uses the reader class, only
 * those images count; otherwise UI-looking images are dropped and the largest
 * group sharing one directory is taken as the pages.
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
      if (group.length > picked.length) picked = group;
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

/**
 * True when `candidate` is the confirmed issue page or its own pagination:
 * same origin, and the path is the confirmed path or under it
 * (`?page=2`, `/2/`). `issue-1` never matches `issue-10` or `issue-2`.
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
  const base = b.pathname.replace(/\/+$/, "");
  const path = a.pathname.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
}
