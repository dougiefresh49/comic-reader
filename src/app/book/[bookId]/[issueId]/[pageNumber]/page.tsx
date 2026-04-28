import { notFound } from "next/navigation";
import { getManifest, getPageData } from "~/server";
import ZenComicReader from "~/components/ZenComicReader";
import { pageImageUrl } from "~/lib/storage";

export const revalidate = 86400;

interface BookPageProps {
  params: Promise<{
    bookId: string;
    issueId: string;
    pageNumber: string;
  }>;
}

export default async function BookPage({ params }: BookPageProps) {
  const { bookId, issueId, pageNumber } = await params;

  const manifest = await getManifest();

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

  const pageImage = pageImageUrl(bookId, issueId, pageNum);

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
        pageNumber={pageNum}
        pageCount={issue.pageCount}
        prevPageLink={prevPageLink}
        nextPageLink={nextPageLink}
      />
    </main>
  );
}
