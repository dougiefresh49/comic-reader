import { supabaseAdmin } from "~/lib/supabase-admin";
import { listAllIssues } from "~/lib/issue-queries";
import { pageImageUrl } from "~/lib/storage";
import { AddFlow } from "./AddFlow";
import { isPickable, type FlowBook, type FlowIssue } from "./model";

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

  const [booksRes, issuesRes] = await Promise.all([
    supabaseAdmin
      .from("books")
      .select(
        "id, name, publisher, total_issues, published, wiki_host, wiki_title_template",
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
      }> | null;
      error: { message: string } | null;
    }>,
    listAllIssues(
      supabaseAdmin,
      "id, book_id, number, page_count, pipeline_step, created_at",
    )
      .order("book_id")
      .order("number"),
  ]);
  if (booksRes.error) throw new Error(`books: ${booksRes.error.message}`);
  if (issuesRes.error) throw new Error(`issues: ${issuesRes.error.message}`);

  const issues: FlowIssue[] = (issuesRes.data ?? []).map((row) => ({
    bookId: row.book_id,
    id: row.id,
    number: row.number,
    pageCount: row.page_count,
    pipelineStep: row.pipeline_step,
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
  }));

  // Resume: the newest issue of an unpublished book that is saved with no
  // pages yet.
  const draftBooks = new Set(
    books.filter((b) => !b.published).map((b) => b.id),
  );
  const resume =
    issues
      .filter((i) => draftBooks.has(i.bookId) && isPickable(i))
      .sort((a, b) =>
        (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
      )[0] ?? null;

  return (
    <AddFlow
      books={books}
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
