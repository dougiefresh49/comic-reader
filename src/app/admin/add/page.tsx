import { supabaseAdmin } from "~/lib/supabase-admin";
import { listAllIssues } from "~/lib/issue-queries";
import { pageImageUrl } from "~/lib/storage";
import { getStoredPageCounts } from "~/server";
import { AddFlow } from "./AddFlow";
import {
  isPickable,
  type FlowBook,
  type FlowFranchise,
  type FlowIssue,
  type FlowSeries,
} from "./model";

export const dynamic = "force-dynamic";
// Check pages may run a browser session (previewSource).
export const maxDuration = 300;

/**
 * One guided flow for a book, an issue and its pages (#793). `?book=<id>`
 * opens at Issue, `?book=<id>&issue=<id>` at Pages. Saved state is read from
 * the rows here, never from local storage.
 */
export default async function AddContentPage({
  searchParams,
}: {
  searchParams: Promise<{ book?: string; issue?: string; stopped?: string }>;
}) {
  const {
    book: bookParam,
    issue: issueParam,
    stopped: stoppedParam,
  } = await searchParams;
  // `<bookId>/<issueId>` of an online download stopped from Saving.
  const [stoppedBook, stoppedIssue] = stoppedParam?.split("/") ?? [];

  const [booksRes, seriesRes, franchisesRes, castRes, issuesRes, stored] =
    await Promise.all([
      supabaseAdmin
        .from("books")
        .select(
          "id, name, publisher, total_issues, published, wiki_host, wiki_title_template, series_id, series_position",
        )
        .order("name") as unknown as Promise<{
        data: Array<{
          id: string;
          name: string;
          publisher: string | null;
          total_issues: number | null;
          published: boolean;
          wiki_host: string | null;
          wiki_title_template: string | null;
          series_id: string | null;
          series_position: number | null;
        }> | null;
        error: { message: string } | null;
      }>,
      supabaseAdmin.from("series").select("id, name") as unknown as Promise<{
        data: FlowSeries[] | null;
        error: { message: string } | null;
      }>,
      supabaseAdmin
        .from("franchises")
        .select("id, name")
        .order("name") as unknown as Promise<{
        data: { id: string; name: string }[] | null;
        error: { message: string } | null;
      }>,
      // Each character's franchise, counted below for the franchise picker.
      supabaseAdmin
        .from("characters")
        .select("franchise_id")
        .not("franchise_id", "is", null) as unknown as Promise<{
        data: { franchise_id: string | null }[] | null;
        error: { message: string } | null;
      }>,
      listAllIssues(
        supabaseAdmin,
        "id, book_id, number, page_count, pipeline_step, status, created_at",
      )
        .order("book_id")
        .order("number"),
      getStoredPageCounts(),
    ]);
  if (booksRes.error) throw new Error(`books: ${booksRes.error.message}`);
  if (seriesRes.error) throw new Error(`series: ${seriesRes.error.message}`);
  if (franchisesRes.error)
    throw new Error(`franchises: ${franchisesRes.error.message}`);
  if (castRes.error) throw new Error(`characters: ${castRes.error.message}`);
  if (issuesRes.error) throw new Error(`issues: ${issuesRes.error.message}`);

  const issues: FlowIssue[] = (issuesRes.data ?? []).map((row) => ({
    bookId: row.book_id,
    id: row.id,
    number: row.number,
    pageCount: row.page_count,
    storedPages: stored[row.book_id]?.[row.id] ?? 0,
    pipelineStep: row.pipeline_step,
    status: row.status,
    createdAt: row.created_at,
    cover: row.page_count > 0 ? pageImageUrl(row.book_id, row.id, 1) : null,
  }));

  const books: FlowBook[] = (booksRes.data ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    publisher: b.publisher,
    totalIssues: b.total_issues,
    published: b.published,
    wikiHost: b.wiki_host,
    wikiTitleTemplate: b.wiki_title_template,
    cover:
      issues.find((i) => i.bookId === b.id && i.cover !== null)?.cover ?? null,
    seriesId: b.series_id,
    seriesPosition: b.series_position,
  }));

  const castCount = new Map<string, number>();
  for (const c of castRes.data ?? [])
    if (c.franchise_id)
      castCount.set(c.franchise_id, (castCount.get(c.franchise_id) ?? 0) + 1);
  const franchises: FlowFranchise[] = (franchisesRes.data ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    characters: castCount.get(f.id) ?? 0,
  }));

  // Resume: the newest issue of an unpublished book that is saved with no
  // pages yet. Not the issue whose download was just left running: it is
  // still storing, so it is not waiting on anyone.
  const draftBooks = new Set(
    books.filter((b) => !b.published).map((b) => b.id),
  );
  const resume =
    issues
      .filter(
        (i) =>
          draftBooks.has(i.bookId) &&
          isPickable(i) &&
          !(i.bookId === stoppedBook && i.id === stoppedIssue),
      )
      .sort((a, b) =>
        (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
      )[0] ?? null;

  return (
    <AddFlow
      books={books}
      series={seriesRes.data ?? []}
      franchises={franchises}
      issues={issues}
      resume={resume ? { bookId: resume.bookId, issueId: resume.id } : null}
      stopped={
        stoppedBook && stoppedIssue
          ? { bookId: stoppedBook, issueId: stoppedIssue }
          : null
      }
      initialBookId={bookParam ?? null}
      initialIssueId={issueParam ?? null}
    />
  );
}
