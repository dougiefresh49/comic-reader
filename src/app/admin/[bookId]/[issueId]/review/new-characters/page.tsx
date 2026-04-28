import Link from "next/link";
import {
  getBookDisplayLabel,
  getIssueDisplayLabel,
  getNewCharacterReviews,
} from "~/server/admin/new-characters";
import { getKnownCharactersForIssue } from "~/server/admin/speakers";
import { NewCharactersReviewClient } from "./NewCharactersReviewClient";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

export default async function ReviewNewCharactersPage({ params }: Params) {
  const { bookId, issueId } = await params;
  const [{ autoResolved, queue }, knownCharacters, bookLabel, issueLabel] =
    await Promise.all([
      getNewCharacterReviews(bookId, issueId),
      getKnownCharactersForIssue(bookId),
      getBookDisplayLabel(bookId),
      getIssueDisplayLabel(bookId, issueId),
    ]);

  const keptInitially = autoResolved.filter(
    (r) => r.autoReason === "kept_as_new",
  ).length;
  const initialSnapshotTotal = queue.length + keptInitially;
  const empty = autoResolved.length === 0 && queue.length === 0;

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-4xl">
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
          Review New Characters — {bookLabel} / {issueLabel}
        </h1>
        <p className="mb-8 text-sm text-neutral-400">
          Decide which detected names are new roles vs aliases of existing
          characters before voice sourcing runs.
        </p>
        {empty ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-sm text-neutral-400">
            No candidate speakers found for this issue (or everyone is already
            known, cast, or marked Narrator). Run{" "}
            <code className="text-neutral-300">clean-voice-descriptions</code>{" "}
            after bubbles exist if you expected a queue here.
          </div>
        ) : (
          <NewCharactersReviewClient
            bookId={bookId}
            issueId={issueId}
            initialAutoResolved={autoResolved}
            initialQueue={queue}
            knownCharacters={knownCharacters}
            initialSnapshotTotal={initialSnapshotTotal}
          />
        )}
      </div>
    </main>
  );
}
