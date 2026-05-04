import Link from "next/link";
import {
  getAdminIssues,
  getAdminBooksWithParts,
  type AdminIssueRow,
  type AdminBookInfo,
} from "~/server/admin/queries";
import { TriggerIngestButton } from "./TriggerIngestButton";

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
    <main className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Admin Dashboard</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Pipeline status across all books and issues.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/admin/voices"
              className="rounded bg-neutral-700 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-600"
            >
              Voices
            </Link>
            <Link
              href="/admin/add-book"
              className="rounded bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-600"
            >
              + Add Book
            </Link>
            <Link
              href="/admin/add-issue"
              className="rounded bg-indigo-700 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-600"
            >
              + Add Issue
            </Link>
            <Link
              href="/admin/new-issue"
              className="rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
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
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-lg font-medium">{book.name}</h2>
        <div className="flex gap-2 text-xs text-neutral-500">
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
                  <IssueTable issues={partIssues} />
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
              <IssueTable issues={issuesByPart.get(null)!} />
            </div>
          )}
        </div>
      ) : (
        <IssueTable issues={issues} />
      )}
    </section>
  );
}

function IssueTable({ issues }: { issues: AdminIssueRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-800">
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
              <td className="px-4 py-2 text-neutral-300">{iss.bubbleCount}</td>
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
  );
}

function StatusBadge({
  issue,
}: {
  issue: { pipelinePaused: boolean; status: string };
}) {
  if (issue.pipelinePaused) {
    return (
      <span className="rounded bg-yellow-700/30 px-2 py-0.5 text-xs font-medium text-yellow-300">
        Paused
      </span>
    );
  }
  if (issue.status === "ready") {
    return (
      <span className="rounded bg-emerald-700/30 px-2 py-0.5 text-xs font-medium text-emerald-300">
        Ready
      </span>
    );
  }
  return (
    <span className="rounded bg-neutral-700/30 px-2 py-0.5 text-xs font-medium text-neutral-400">
      {issue.status}
    </span>
  );
}

function ActionButtons({
  issue,
}: {
  issue: {
    bookId: string;
    issueId: string;
    pipelinePaused: boolean;
    pipelinePausedUrl: string | null;
    pipelineStep: string | null;
    hasWebP: boolean;
    pageCount: number;
  };
}) {
  if (issue.pipelinePaused && issue.pipelinePausedUrl) {
    return (
      <Link
        href={issue.pipelinePausedUrl}
        className="rounded bg-yellow-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-yellow-600"
      >
        Resume
      </Link>
    );
  }

  const canTrigger =
    issue.pageCount > 0 &&
    (issue.pipelineStep === "pages-downloaded" ||
      issue.pipelineStep?.startsWith("failed:"));

  return (
    <div className="flex gap-2">
      {canTrigger && <TriggerIngestButton issueId={issue.issueId} />}
      {issue.hasWebP && (
        <Link
          href={`/book/${issue.bookId}/${issue.issueId}/1`}
          className="rounded bg-neutral-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-600"
        >
          View
        </Link>
      )}
      <Link
        href={`/book/${issue.bookId}/${issue.issueId}/review`}
        className="rounded bg-cyan-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-cyan-600"
      >
        Review
      </Link>
      <Link
        href={`/admin/${issue.bookId}/${issue.issueId}/review/panels`}
        className="rounded bg-fuchsia-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-fuchsia-600"
      >
        Panels
      </Link>
    </div>
  );
}
