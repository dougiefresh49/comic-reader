import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";

/**
 * Refresh the reader after an admin action changed what a kid reads.
 *
 * The reader is `/book/<bookId>/<issueId>/<pageNumber>`, one page per route.
 * It is not cached today: the route is dynamic, with no `generateStaticParams`,
 * so every request renders the page from Supabase and these calls have no
 * cached page to expire. They stay as the wiring for the day the reader is
 * cached (#515), when an admin write that skips them would leave a kid on the
 * old page. There is no page at `/book/<bookId>/<issueId>`, so revalidating
 * that path, as an older version of this helper did, refreshes nothing.
 *
 * Every call passes a concrete path and no type argument. Its cache tag is
 * then the page's own pathname tag, `_N_T_/book/<bookId>/<issueId>/<n>`,
 * which is one of the tags the reader page carries. The other documented
 * form, the bracketed pattern with the "page" type, is deliberately not used:
 * its tag, `_N_T_/book/[bookId]/[issueId]/[pageNumber]/page`, is derived from
 * the route definition rather than the page, so it is attached to every reader
 * page of every book in the repo. Once the reader is cached, a save in one
 * issue would expire the cached reader pages of the whole library.
 *
 * Pass `pageNumbers` when the action knows which pages it touched. Left out,
 * the helper reads the issue's own page numbers from `pages` and revalidates
 * those, so an action that touches every page of one issue stays inside that
 * issue.
 */
export async function revalidateReaderPages(
  bookId: string,
  issueId: string,
  pageNumbers?: number[],
): Promise<void> {
  const pages = pageNumbers ?? (await issuePageNumbers(bookId, issueId));
  for (const pageNumber of new Set(pages)) {
    revalidatePath(`/book/${bookId}/${issueId}/${pageNumber}`);
  }
}

/** Read `pages.number` for one issue, scoped by both book and issue. */
async function issuePageNumbers(
  bookId: string,
  issueId: string,
): Promise<number[]> {
  const { data, error } = await supabaseAdmin
    .from("pages")
    .select("number")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);
  if (error) {
    // Revalidating is best effort, and this runs after the write committed.
    // Throwing here would report a failed save for a save that landed.
    console.error(
      `reader revalidate: pages query failed for ${bookId}/${issueId}: ${error.message}`,
    );
    return [];
  }
  return (data ?? []).map((row) => (row as { number: number }).number);
}
