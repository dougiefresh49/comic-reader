import Link from "next/link";
import {
  getKnownCharactersForIssue,
  getSpeakerReviews,
} from "~/server/admin/speakers";
import { SpeakersReviewClient } from "./SpeakersReviewClient";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

export default async function ReviewSpeakersPage({ params }: Params) {
  const { bookId, issueId } = await params;
  const [reviews, knownCharacters] = await Promise.all([
    getSpeakerReviews(bookId, issueId),
    getKnownCharactersForIssue(bookId),
  ]);

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
        <h1 className="mb-2 text-2xl font-semibold">Review speakers</h1>
        <p className="mb-8 text-sm text-neutral-400">
          Review unknown speakers detected by Gemini before voice-sourcing runs.
        </p>
        {reviews.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-sm text-neutral-400">
            No speaker reviews queued for this issue. Run{" "}
            <code className="rounded bg-neutral-800 px-1.5 py-0.5">
              pnpm review-speakers -- --book {bookId} --issue {issueId} --db
            </code>{" "}
            to populate the review queue.
          </div>
        ) : (
          <SpeakersReviewClient
            bookId={bookId}
            issueId={issueId}
            initialReviews={reviews}
            knownCharacters={knownCharacters}
          />
        )}
      </div>
    </main>
  );
}
