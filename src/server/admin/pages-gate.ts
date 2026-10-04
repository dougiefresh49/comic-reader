/**
 * The one check behind the pages stop (#384): the editor's Approve issue
 * (`checkIssueReady`) and the resume endpoint both ask it before the
 * `page-review` hook resumes, so a direct POST cannot skip it.
 */
import "server-only";
import { selectIssue } from "~/lib/issue-queries";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { SPOKEN, needsSpeaker } from "~/components/review-editor/model";

export type ReadyResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** The page to show the owner: the first with a bubble that needs a speaker, else the first not approved. */
      page?: number;
      /** Pages the saved rows say are not approved. */
      unapproved?: number[];
    };

export function bubbleWord(n: number): string {
  return `${n} spoken ${n === 1 ? "bubble" : "bubbles"}`;
}

/**
 * How many saved bubbles fail `needsSpeaker`, by page: one page, or the whole
 * issue when `page` is left out. The same rule the editor asks.
 */
export async function unvoicedByPage(
  bookId: string,
  issueId: string,
  page?: number,
): Promise<
  { ok: true; counts: Map<number, number> } | { ok: false; error: string }
> {
  let query = supabaseAdmin
    .from("bubbles")
    .select("page_number, type, speaker, silent, ignored", { count: "exact" })
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .in("type", SPOKEN);
  if (page !== undefined) query = query.eq("page_number", page);
  const { data, error, count } = await query;
  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as {
    page_number: number;
    type: string;
    speaker: string | null;
    silent: boolean | null;
    ignored: boolean | null;
  }[];
  // A capped read would pass bubbles it never saw.
  if (count !== null && count > rows.length)
    return {
      ok: false,
      error: `only ${rows.length} of ${count} bubbles came back in one read`,
    };
  const counts = new Map<number, number>();
  for (const b of rows) {
    if (
      needsSpeaker({
        type: b.type,
        speaker: b.speaker,
        silent: b.silent ?? false,
        ignored: b.ignored ?? false,
      })
    )
      counts.set(b.page_number, (counts.get(b.page_number) ?? 0) + 1);
  }
  return { ok: true, counts };
}

/**
 * From the saved rows: the issue is paused at `review-pages`, every page has
 * `reviewed_at`, and no page has a spoken bubble with no speaker that is not
 * silent. An edit made after a page was approved is caught here, and so is a
 * page another tab took back.
 */
export async function canResumePages(
  bookId: string,
  issueId: string,
): Promise<ReadyResult> {
  const issue = await selectIssue(
    supabaseAdmin,
    bookId,
    issueId,
    "pipeline_step, pipeline_paused",
  ).maybeSingle();
  if (issue.error)
    return {
      ok: false,
      error: `Not resumed: the issue could not be read (${issue.error.message}).`,
    };
  const row = issue.data as {
    pipeline_step: string | null;
    pipeline_paused: boolean | null;
  } | null;
  if (!row) return { ok: false, error: "Not resumed: the issue has no row." };
  if (row.pipeline_step !== "review-pages" || row.pipeline_paused !== true)
    return {
      ok: false,
      error: `Not resumed: the run is not paused at the pages gate (its step reads ${row.pipeline_step ?? "nothing"}${row.pipeline_paused ? ", paused" : ", not paused"}).`,
    };

  const [pages, unvoiced] = await Promise.all([
    supabaseAdmin
      .from("pages")
      .select("number, reviewed_at")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .order("number"),
    unvoicedByPage(bookId, issueId),
  ]);
  if (pages.error)
    return {
      ok: false,
      error: `Not resumed: the pages could not be read (${pages.error.message}).`,
    };
  if (!unvoiced.ok)
    return {
      ok: false,
      error: `Not resumed: the bubbles could not be read (${unvoiced.error}).`,
    };
  const pageRows = (pages.data ?? []) as {
    number: number;
    reviewed_at: string | null;
  }[];
  if (pageRows.length === 0)
    return { ok: false, error: "Not resumed: the issue has no pages rows." };

  const problems: string[] = [];
  const voiceless = Array.from(unvoiced.counts.entries()).sort(
    (a, b) => a[0] - b[0],
  );
  for (const [n, missing] of voiceless)
    problems.push(
      `page ${n} has ${bubbleWord(missing)} with no speaker, not marked silent`,
    );
  const unapproved = pageRows
    .filter((p) => !p.reviewed_at)
    .map((p) => p.number);
  if (unapproved.length > 0)
    problems.push(
      `${unapproved.length === 1 ? "page" : "pages"} ${unapproved.join(", ")} ${unapproved.length === 1 ? "is" : "are"} not approved`,
    );
  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    error: `Not resumed: ${problems.join("; ")}.`,
    page: voiceless[0]?.[0] ?? unapproved[0],
    unapproved,
  };
}
