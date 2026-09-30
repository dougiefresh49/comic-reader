import { revalidatePath } from "next/cache";

/** The route definition the reader page is built from, with its segments
 *  still bracketed. Next derives one cache tag per segment from this, and
 *  the tag it derives for the page itself is this string plus `/page`. */
const READER_PAGE_PATTERN = "/book/[bookId]/[issueId]/[pageNumber]";

/**
 * Refresh the reader after an admin action changed what a kid reads.
 *
 * The reader is `/book/<bookId>/<issueId>/<pageNumber>`, one page per route,
 * cached for a day (`revalidate = 86400` in that page). There is no page at
 * `/book/<bookId>/<issueId>`, so the old call revalidated a route nothing
 * renders and the reader kept serving the old page.
 *
 * Exactly two forms reach a cache tag the reader page carries, and the shape
 * is decided by how Next builds the tag. Two tags matter here: the page's own
 * pathname tag, and the one Next derives from the route definition.
 *
 * - a concrete route with no type argument. Its tag is the page's own
 *   pathname tag, `_N_T_/book/<bookId>/<issueId>/<pageNumber>`.
 * - the bracketed pattern with the "page" type. Its tag is the one Next
 *   derives from the route definition, `_N_T_/book/[bookId]/[issueId]/
 *   [pageNumber]/page`.
 *
 * A concrete route WITH a type argument reaches neither. Its tag ends in
 * `/page`, and the only tag ending in `/page` is the pattern's own, because
 * every other derived tag on the page is a layout tag for a parent segment.
 * The same holds for the book index at `/book/<bookId>`: that is a dynamic
 * route too, so it wants `/book/<bookId>` with no type.
 *
 * Pass `pageNumbers` when the action knows which pages it touched, so the
 * reader refreshes those and nothing else. Left out, the helper takes the
 * pattern form, which every book in the repo shares: correct, and wider than
 * the caller meant.
 */
export function revalidateReaderPages(
  bookId: string,
  issueId: string,
  pageNumbers?: number[],
): void {
  if (pageNumbers && pageNumbers.length > 0) {
    for (const pageNumber of pageNumbers) {
      revalidatePath(`/book/${bookId}/${issueId}/${pageNumber}`);
    }
    return;
  }
  revalidatePath(READER_PAGE_PATTERN, "page");
}
