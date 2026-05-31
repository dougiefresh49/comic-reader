import Link from "next/link";
import {
  getAdminIssues,
  getAdminBooksWithParts,
  type AdminIssueRow,
  type AdminBookInfo,
} from "~/server/admin/queries";
import { PipelineActions } from "./PipelineActions";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const [issues, books] = await Promise.all([
    getAdminIssues(),
    getAdminBooksWithParts(),
  ]);

  const issuesByBook = new Map<string, AdminIssueRow[]>();
  for (const iss of issues) {
    const list = issuesByBook.get(iss.bookId) ?? [];
    list.push(iss);
    issuesByBook.set(iss.bookId, list);
  }

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-6 text-neutral-100 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 sm:mb-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold sm:text-2xl">
                Admin Dashboard
              </h1>
              <p className="mt-1 text-sm text-neutral-400">
                Pipeline status across all books and issues.
              </p>
            </div>
            <Link
              href="/admin/voices"
              className="shrink-0 rounded bg-neutral-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-600 sm:px-4 sm:py-2 sm:text-sm"
            >
              Voices
            </Link>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/admin/add-book"
              className="rounded bg-cyan-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-600 sm:px-4 sm:py-2 sm:text-sm"
            >
              + Add Book
            </Link>
            <Link
              href="/admin/add-issue"
              className="rounded bg-indigo-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-600 sm:px-4 sm:py-2 sm:text-sm"
            >
              + Add Issue
            </Link>
            <Link
              href="/admin/new-issue"
              className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 sm:px-4 sm:py-2 sm:text-sm"
            >
              + Upload Pages
            </Link>
          </div>
        </header>

        {books.length === 0 ? (
          <p className="text-sm text-neutral-400">No books yet.</p>
        ) : (
          <div className="space-y-8">
            {books.map((book) => (
              <BookSection
                key={book.id}
                book={book}
                issues={issuesByBook.get(book.id) ?? []}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function BookSection({
  book,
  issues,
}: {
  book: AdminBookInfo;
  issues: AdminIssueRow[];
}) {
  const hasParts = book.parts.length > 0;

  const issuesByPart = new Map<string | null, AdminIssueRow[]>();
  for (const iss of issues) {
    const key = iss.partId;
    const list = issuesByPart.get(key) ?? [];
    list.push(iss);
    issuesByPart.set(key, list);
  }

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline gap-2 sm:gap-3">
        <h2 className="text-lg font-medium">{book.name}</h2>
        <div className="flex flex-wrap gap-2 text-xs text-neutral-500">
          {book.publisher && <span>{book.publisher}</span>}
          {book.franchises && book.franchises.length > 0 && (
            <span>{book.franchises.join(", ")}</span>
          )}
          {book.totalIssues && (
            <span>
              {issues.length}/{book.totalIssues} issues
            </span>
          )}
          {!book.totalIssues && (
            <span>
              {issues.length} {issues.length === 1 ? "issue" : "issues"}
            </span>
          )}
        </div>
        <Link
          href={`/admin/add-issue?book=${book.id}`}
          className="ml-auto rounded bg-indigo-700/60 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-600"
        >
          + Issue
        </Link>
      </div>

      {hasParts ? (
        <div className="space-y-4">
          {book.parts.map((part) => {
            const partIssues = issuesByPart.get(part.id) ?? [];
            return (
              <div key={part.id}>
                <h3 className="mb-1.5 text-sm font-medium text-neutral-400">
                  {part.name}
                  {part.totalIssues != null && (
                    <span className="ml-2 text-xs text-neutral-600">
                      {partIssues.length}/{part.totalIssues}
                    </span>
                  )}
                </h3>
                {partIssues.length > 0 ? (
                  <IssueList issues={partIssues} />
                ) : (
                  <p className="py-2 text-xs text-neutral-600">
                    No issues yet.
                  </p>
                )}
              </div>
            );
          })}
          {(issuesByPart.get(null) ?? []).length > 0 && (
            <div>
              <h3 className="mb-1.5 text-sm font-medium text-neutral-400">
                Unassigned
              </h3>
              <IssueList issues={issuesByPart.get(null)!} />
            </div>
          )}
        </div>
      ) : (
        <IssueList issues={issues} />
      )}
    </section>
  );
}

function IssueList({ issues }: { issues: AdminIssueRow[] }) {
  return (
    <>
      {/* Desktop: table */}
      <div className="hidden overflow-hidden rounded-lg border border-neutral-800 md:block">
        <table className="w-full">
          <thead className="bg-neutral-900 text-xs text-neutral-400 uppercase">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Issue</th>
              <th className="px-4 py-2 text-left font-medium">Pages</th>
              <th className="px-4 py-2 text-left font-medium">Bubbles</th>
              <th className="px-4 py-2 text-left font-medium">Audio</th>
              <th className="px-4 py-2 text-left font-medium">Pipeline</th>
              <th className="px-4 py-2 text-left font-medium">State</th>
              <th className="px-4 py-2 text-left font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800 text-sm">
            {issues.map((iss) => (
              <tr key={`${iss.bookId}/${iss.issueId}`}>
                <td className="px-4 py-2 text-neutral-300">
                  {iss.number}. {iss.issueName}
                </td>
                <td className="px-4 py-2 text-neutral-300">{iss.pageCount}</td>
                <td className="px-4 py-2 text-neutral-300">
                  {iss.bubbleCount}
                </td>
                <td className="px-4 py-2 text-neutral-300">{iss.audioCount}</td>
                <td className="px-4 py-2 text-neutral-400">
                  {iss.pipelineStep ?? "—"}
                </td>
                <td className="px-4 py-2">
                  <StatusBadge issue={iss} />
                </td>
                <td className="px-4 py-2">
                  <ActionButtons issue={iss} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: cards */}
      <div className="space-y-3 md:hidden">
        {issues.map((iss) => (
          <IssueCard key={`${iss.bookId}/${iss.issueId}`} issue={iss} />
        ))}
      </div>
    </>
  );
}

function IssueCard({ issue }: { issue: AdminIssueRow }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-neutral-200">
            {issue.number}. {issue.issueName}
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">
            {issue.pipelineStep ?? "no pipeline"}
          </p>
        </div>
        <StatusBadge issue={issue} />
      </div>

      <div className="mt-2 flex gap-4 text-xs text-neutral-400">
        <span>
          <span className="text-neutral-500">Pg</span> {issue.pageCount}
        </span>
        <span>
          <span className="text-neutral-500">Bbl</span> {issue.bubbleCount}
        </span>
        <span>
          <span className="text-neutral-500">Aud</span> {issue.audioCount}
        </span>
      </div>

      <div className="mt-2.5">
        <ActionButtons issue={issue} />
      </div>
    </div>
  );
}

function StatusBadge({ issue }: { issue: AdminIssueRow }) {
  if (issue.pipelinePaused) {
    return (
      <span className="shrink-0 rounded bg-yellow-700/30 px-2 py-0.5 text-xs font-medium text-yellow-300">
        Paused
      </span>
    );
  }
  if (issue.status === "ready") {
    return (
      <span className="shrink-0 rounded bg-emerald-700/30 px-2 py-0.5 text-xs font-medium text-emerald-300">
        Ready
      </span>
    );
  }
  if (issue.pipelineStep?.startsWith("failed:")) {
    return (
      <span className="rounded bg-red-700/30 px-2 py-0.5 text-xs font-medium text-red-300">
        Failed
      </span>
    );
  }
  if (
    issue.pipelineStep &&
    issue.pipelineStep !== "pages-downloaded" &&
    issue.pipelineStep !== "complete"
  ) {
    return (
      <span className="rounded bg-cyan-700/30 px-2 py-0.5 text-xs font-medium text-cyan-300">
        Running
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded bg-neutral-700/30 px-2 py-0.5 text-xs font-medium text-neutral-400">
      {issue.status}
    </span>
  );
}

function ActionButtons({ issue }: { issue: AdminIssueRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
      <PipelineActions
        bookId={issue.bookId}
        issueId={issue.issueId}
        pipelineStep={issue.pipelineStep}
        pipelinePaused={issue.pipelinePaused}
        pipelinePausedAt={issue.pipelinePausedAt}
        pipelinePausedUrl={issue.pipelinePausedUrl}
        pageCount={issue.pageCount}
      />
      <Link
        href={`/admin/${issue.bookId}/${issue.issueId}/review/pipeline`}
        className="rounded bg-neutral-700 px-2 py-1 text-xs font-medium text-neutral-300 hover:bg-neutral-600"
        title="Pipeline details"
      >
        Details
      </Link>
    </div>
  );
}
