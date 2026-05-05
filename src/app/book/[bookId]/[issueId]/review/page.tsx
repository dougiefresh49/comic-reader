import { notFound } from "next/navigation";
import { getManifest, getIssueData } from "~/server";
import { ReviewLayout } from "~/components/review/ReviewLayout";

export const revalidate = 86400;

interface ReviewPageProps {
  params: Promise<{
    bookId: string;
    issueId: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReviewPage({
  params,
  searchParams,
}: ReviewPageProps) {
  const { bookId, issueId } = await params;
  const sp = await searchParams;

  const manifest = await getManifest();

  const book = manifest.books.find((b) => b.id === bookId);
  if (!book) notFound();

  const issue = book.issues.find((i) => i.id === issueId);
  if (!issue) notFound();

  const rawPage = typeof sp.page === "string" ? parseInt(sp.page, 10) : 1;
  const initialPage = isNaN(rawPage)
    ? 1
    : Math.max(1, Math.min(rawPage, issue.pageCount));

  const { allBubbles, characters } = await getIssueData(bookId, issueId);
  const mode = typeof sp.mode === "string" ? sp.mode : undefined;

  return (
    <ReviewLayout
      bookId={bookId}
      issueId={issueId}
      issueData={issue}
      allBubbles={allBubbles}
      characters={characters}
      initialPage={initialPage}
      mode={mode}
    />
  );
}
