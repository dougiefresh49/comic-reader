import Link from "next/link";
import { getAdminIssues } from "~/server/admin/queries";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const issues = await getAdminIssues();

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
          <Link
            href="/admin/new-issue"
            className="rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
          >
            + New Issue
          </Link>
        </header>

        <section className="mb-6">
          <h2 className="mb-3 text-lg font-medium">Issues</h2>
          {issues.length === 0 ? (
            <p className="text-sm text-neutral-400">No issues yet.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-neutral-800">
              <table className="w-full">
                <thead className="bg-neutral-900 text-xs text-neutral-400 uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Book</th>
                    <th className="px-4 py-2 text-left font-medium">Issue</th>
                    <th className="px-4 py-2 text-left font-medium">Pages</th>
                    <th className="px-4 py-2 text-left font-medium">Bubbles</th>
                    <th className="px-4 py-2 text-left font-medium">Audio</th>
                    <th className="px-4 py-2 text-left font-medium">
                      Pipeline
                    </th>
                    <th className="px-4 py-2 text-left font-medium">State</th>
                    <th className="px-4 py-2 text-left font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800 text-sm">
                  {issues.map((iss) => (
                    <tr key={`${iss.bookId}/${iss.issueId}`}>
                      <td className="px-4 py-2 text-neutral-200">
                        {iss.bookName}
                      </td>
                      <td className="px-4 py-2 text-neutral-300">
                        {iss.number}. {iss.issueName}
                      </td>
                      <td className="px-4 py-2 text-neutral-300">
                        {iss.pageCount}
                      </td>
                      <td className="px-4 py-2 text-neutral-300">
                        {iss.bubbleCount}
                      </td>
                      <td className="px-4 py-2 text-neutral-300">
                        {iss.audioCount}
                      </td>
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
          )}
        </section>
      </div>
    </main>
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
        ⏸ Paused
      </span>
    );
  }
  if (issue.status === "ready") {
    return (
      <span className="rounded bg-emerald-700/30 px-2 py-0.5 text-xs font-medium text-emerald-300">
        ✓ Ready
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
    hasWebP: boolean;
  };
}) {
  if (issue.pipelinePaused && issue.pipelinePausedUrl) {
    return (
      <Link
        href={issue.pipelinePausedUrl}
        className="rounded bg-yellow-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-yellow-600"
      >
        Resume →
      </Link>
    );
  }
  return (
    <div className="flex gap-2">
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
    </div>
  );
}
