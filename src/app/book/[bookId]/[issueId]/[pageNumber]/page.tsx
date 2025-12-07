import { notFound } from "next/navigation";
import Link from "next/link";
import manifest from "~/data/manifest";
import ComicReader from "~/components/ComicReader";
import ComicReaderOverlayTest from "~/components/ComicReaderOverlayTest";
import { getPageData } from "~/server";

interface BookPageProps {
  params: Promise<{
    bookId: string;
    issueId: string;
    pageNumber: string;
  }>;
}

export default async function BookPage({ params }: BookPageProps) {
  const { bookId, issueId, pageNumber } = await params;

  // Find the book
  const book = manifest.books.find((b) => b.id === bookId);
  if (!book) {
    notFound();
  }

  // Find the issue
  const issue = book.issues.find((i) => i.id === issueId);
  if (!issue) {
    notFound();
  }

  const pageNum = parseInt(pageNumber, 10);
  if (isNaN(pageNum) || pageNum < 1 || pageNum > issue.pageCount) {
    notFound();
  }

  // Format page number with leading zero (e.g., "01", "02")
  const formattedPageNum = String(pageNum).padStart(2, "0");
  const pageImage = `/comics/${bookId}/${issueId}/pages/page-${formattedPageNum}.webp`;

  // Fetch bubble data and timestamps
  const { bubbles, timestamps } = await getPageData(
    bookId,
    issueId,
    pageNumber,
  );

  const prevPage = pageNum > 1 ? pageNum - 1 : null;
  const nextPage = pageNum < issue.pageCount ? pageNum + 1 : null;

  return (
    <main className="min-h-screen bg-black">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-4 flex items-center justify-between text-white">
          <div>
            <Link
              href={`/book/${bookId}`}
              className="text-sm text-gray-400 hover:text-white"
            >
              ← Back to {book.name}
            </Link>
            <h1 className="mt-1 text-2xl font-bold">{book.name}</h1>
            <p className="text-gray-400">{issue.name}</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-400">
              Page {pageNum} of {issue.pageCount}
            </p>
          </div>
        </div>

        {/* Interactive Comic Reader */}
        {/* <ComicReader
          pageImage={pageImage}
          bubbles={bubbles}
          timestamps={timestamps}
          bookId={bookId}
          issueId={issueId}
        /> */}

        {/* Overlay Test Component */}
        <ComicReaderOverlayTest
          pageImage={pageImage}
          bubbles={bubbles}
          timestamps={timestamps}
          bookId={bookId}
          issueId={issueId}
        />

        {/* Navigation */}
        <div className="mt-4 flex justify-center gap-4">
          {prevPage ? (
            <Link
              href={`/book/${bookId}/${issueId}/${prevPage}`}
              className="rounded bg-gray-700 px-6 py-2 text-white transition-colors hover:bg-gray-600"
            >
              ← Previous
            </Link>
          ) : (
            <button
              disabled
              className="rounded bg-gray-800 px-6 py-2 text-gray-500"
            >
              ← Previous
            </button>
          )}

          {nextPage ? (
            <Link
              href={`/book/${bookId}/${issueId}/${nextPage}`}
              className="rounded bg-gray-700 px-6 py-2 text-white transition-colors hover:bg-gray-600"
            >
              Next →
            </Link>
          ) : (
            <button
              disabled
              className="rounded bg-gray-800 px-6 py-2 text-gray-500"
            >
              Next →
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
