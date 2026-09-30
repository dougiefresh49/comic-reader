import { notFound } from "next/navigation";
import { getReaderPage } from "~/server";
import ZenComicReader from "~/components/ZenComicReader";

// The owner's view of any book, draft or published. It sits under /admin so
// the basic-auth matcher covers it: browsers send the admin credentials only
// under the path that asked for them, so /book/... never sees them.
export const dynamic = "force-dynamic";

interface PreviewPageProps {
  params: Promise<{
    bookId: string;
    issueId: string;
    pageNumber: string;
  }>;
}

export default async function PreviewPage({ params }: PreviewPageProps) {
  const { bookId, issueId, pageNumber } = await params;

  const reader = await getReaderPage({
    bookId,
    issueId,
    pageNumber,
    publishedOnly: false,
    basePath: "/admin/preview",
  });
  if (!reader) notFound();

  return (
    <main className="min-h-screen bg-black">
      <ZenComicReader {...reader} />
    </main>
  );
}
