import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";

/**
 * How many `pages` rows an issue has. Confirm and the downloader refuse an
 * issue with any, since `issues.page_count` lags the rows when a download is
 * interrupted (#792 review).
 */
export async function countIssuePages(
  bookId: string,
  issueId: string,
): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("pages")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId)
    .eq("issue_id", issueId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}
