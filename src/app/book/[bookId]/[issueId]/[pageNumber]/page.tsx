import { notFound } from "next/navigation";
import { getReaderPage } from "~/server";
import ZenComicReader from "~/components/ZenComicReader";

interface BookPageProps {
  params: Promise<{
    bookId: string;
    issueId: string;
    pageNumber: string;
  }>;
}

export default async function BookPage({ params }: BookPageProps) {
  const { bookId, issueId, pageNumber } = await params;

  const reader = await getReaderPage({
    bookId,
    issueId,
    pageNumber,
    publishedOnly: true,
    basePath: "/book",
  });
  if (!reader) notFound();

  return (
    <main className="min-h-screen bg-black">
      <ZenComicReader {...reader} />
    </main>
  );
}
