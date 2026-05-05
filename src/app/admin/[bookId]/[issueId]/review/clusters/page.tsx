import Link from "next/link";
import { ApproveClusterButton } from "./ApproveClusterButton";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

export default async function ReviewClustersPage({ params }: Params) {
  const { bookId, issueId } = await params;

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <Link
            href="/admin"
            className="text-sm text-neutral-400 hover:text-neutral-200"
          >
            ← Admin
          </Link>
          <span className="text-xs text-neutral-500">
            {bookId} / {issueId}
          </span>
        </div>

        <h1 className="mb-2 text-2xl font-semibold">
          Review character clusters
        </h1>
        <p className="mb-8 text-sm text-neutral-400">
          Confirm, rename, merge, or split face clusters after character
          lookahead. This UI will show cluster grids once the
          character-lookahead step is implemented.
        </p>

        <div className="rounded-lg border border-dashed border-neutral-700 bg-neutral-900/40 p-8 text-center text-sm text-neutral-500">
          Cluster grid and actions will appear here.
        </div>

        <div className="mt-8 flex items-center justify-between">
          <Link
            href={`/admin/${bookId}/${issueId}/review/pipeline`}
            className="text-sm text-cyan-400 hover:text-cyan-300"
          >
            ← Back to pipeline review
          </Link>
          <ApproveClusterButton bookId={bookId} issueId={issueId} />
        </div>
      </div>
    </main>
  );
}
