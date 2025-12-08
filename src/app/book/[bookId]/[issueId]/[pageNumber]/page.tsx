import { notFound } from "next/navigation";
import manifest from "~/data/manifest";
import ZenComicReader from "~/components/ZenComicReader";
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

  const prevPageLink = prevPage
    ? `/book/${bookId}/${issueId}/${prevPage}`
    : null;
  const nextPageLink = nextPage
    ? `/book/${bookId}/${issueId}/${nextPage}`
    : null;

  return (
    <main className="min-h-screen bg-black">
      <ZenComicReader
        pageImage={pageImage}
        bubbles={bubbles}
        timestamps={timestamps}
        bookId={bookId}
        issueId={issueId}
        prevPageLink={prevPageLink}
        nextPageLink={nextPageLink}
      />
    </main>
  );
}

