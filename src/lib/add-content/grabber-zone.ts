/**
 * Find an issue on grabber.zone with plain fetches, no Gemini (#792).
 *
 * Its WordPress search (`/?s=<terms>&post_type=wp-manga`) answers with series
 * cards (`<h3 class="h4"><a href=".../comics/<slug>/">Title</a></h3>`). Each
 * series page links every issue as `/comics/<slug>/<chapter>/`, usually
 * `issue-N` but also `metal-legion-issue-N`. A match is an issue page whose
 * plain fetch lists at least MIN_PAGE_IMAGES page images.
 */
import {
  fetchHtml,
  fetchPageImageUrls,
  MIN_PAGE_IMAGES,
} from "~/lib/add-content/page-images";

const ORIGIN = "https://grabber.zone";
const MAX_SERIES = 3;

export interface GrabberZoneMatch {
  url: string;
  seriesTitle: string;
  pageCount: number;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#0?38;|&amp;/g, "&")
    .replace(/&#8217;|&#039;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/**
 * The series part of a wiki title: `DC X Sonic the Hedgehog Issue 1` becomes
 * `DC X Sonic the Hedgehog`. WordPress search ANDs its terms, and no series
 * title carries the issue number.
 */
export function seriesTerms(wikiTitle: string, issueNumber: number): string {
  const stripped = wikiTitle
    .replace(
      new RegExp(`\\s*(?:issue\\s*)?#?\\s*0*${issueNumber}\\s*$`, "i"),
      "",
    )
    .trim();
  return stripped || wikiTitle;
}

/** Chapter slug score for issue N; -1 when it is not issue N. */
function chapterScore(
  slug: string,
  issueNumber: number,
  contextWords: string[],
): number {
  if (!new RegExp(`(?:^|-)(?:issue|chapter)-0*${issueNumber}$`).test(slug)) {
    return -1;
  }
  const slugWords = words(slug);
  const contextHits = contextWords.filter((w) => slugWords.includes(w)).length;
  const exact = new RegExp(`^issue-0*${issueNumber}$`).test(slug) ? 1 : 0;
  return contextHits * 2 + exact;
}

export async function findOnGrabberZone(args: {
  terms: string;
  issueNumber: number;
  extraContext?: string;
}): Promise<GrabberZoneMatch | null> {
  const contextWords = words(args.extraContext ?? "");
  const query = [args.terms, args.extraContext ?? ""].join(" ").trim();
  const searchHtml = await fetchHtml(
    `${ORIGIN}/?s=${encodeURIComponent(query)}&post_type=wp-manga`,
  );

  // A series counts only when its title holds every word of the terms; the
  // search also matches on descriptions.
  const required = words(args.terms);
  const series = [
    ...searchHtml.matchAll(
      /<h3 class="h4">\s*<a href="(https:\/\/grabber\.zone\/comics\/[^/"]+\/)"[^>]*>([\s\S]*?)<\/a>/g,
    ),
  ]
    .map((m) => ({ url: m[1]!, title: decodeEntities(m[2]!) }))
    .filter((s) => required.every((w) => words(s.title).includes(w)))
    .slice(0, MAX_SERIES);

  for (const s of series) {
    const seriesHtml = await fetchHtml(s.url);
    const chapterRe = new RegExp(
      `href="${s.url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([a-z0-9-]+)/"`,
      "g",
    );
    const best = [
      ...new Set([...seriesHtml.matchAll(chapterRe)].map((m) => m[1]!)),
    ]
      .map((slug) => ({
        slug,
        score: chapterScore(slug, args.issueNumber, contextWords),
      }))
      .filter((c) => c.score >= 0)
      .sort((a, b) => b.score - a.score)[0];
    if (!best) continue;

    const url = `${s.url}${best.slug}/`;
    const images = await fetchPageImageUrls(url);
    if (images.length >= MIN_PAGE_IMAGES) {
      return { url, seriesTitle: s.title, pageCount: images.length };
    }
  }
  return null;
}
