import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { getManifest } from "~/server";
import { pageImageUrl } from "~/lib/storage";
import { getIssueOfflineUrls } from "~/server/offline";
import { OfflineDownload } from "~/components/OfflineDownload";

export const revalidate = 3600;

interface BookDetailProps {
  params: Promise<{
    bookId: string;
  }>;
}

export default async function BookDetailPage({ params }: BookDetailProps) {
  const { bookId } = await params;

  const manifest = await getManifest();

  // Find the book
  const book = manifest.books.find((b) => b.id === bookId);
  if (!book) {
    notFound();
  }

  // Compute offline URL lists for each available issue. Empty for
  // not-yet-ingested issues. ~50 URLs/issue, fast.
  const offlineUrlsByIssue: Record<string, string[]> = {};
  await Promise.all(
    book.issues
      .filter((i) => i.hasWebP)
      .map(async (issue) => {
        offlineUrlsByIssue[issue.id] = await getIssueOfflineUrls(
          bookId,
          issue.id,
          issue.pageCount,
        );
      }),
  );

  // Get cover image (first page of first issue)
  const firstIssue = book.issues[0];
  const coverImage = firstIssue ? pageImageUrl(bookId, firstIssue.id, 1) : null;

  return (
    <main className="min-h-screen bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
      <div className="container mx-auto px-4 py-8">
        <Link
          href="/"
          className="mb-6 inline-block text-sm text-gray-400 transition-colors hover:text-white"
        >
          ← Back to Library
        </Link>

        <div className="mb-8 flex flex-col gap-6 md:flex-row">
          {/* Cover Image */}
          <div className="flex-shrink-0">
            <div className="relative aspect-[2/3] w-48 overflow-hidden rounded-lg bg-gray-800 shadow-lg md:w-64">
              {coverImage ? (
                <Image
                  src={coverImage}
                  alt={book.name}
                  fill
                  className="object-cover"
                  sizes="256px"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-gray-500">
                  No Cover
                </div>
              )}
            </div>
          </div>

          {/* Book Info */}
          <div className="flex-1">
            <h1 className="mb-2 text-4xl font-bold">{book.name}</h1>
            <p className="mb-4 text-gray-400">
              {book.issues.length} issue{book.issues.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>

        {/* Issues List */}
        <div>
          <h2 className="mb-4 text-2xl font-semibold">Issues</h2>
          {book.issues.length === 0 ? (
            <p className="text-gray-400">No issues available.</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {book.issues.map((issue) => {
                const issueCoverImage = pageImageUrl(bookId, issue.id, 1);
                const isAvailable = issue.hasWebP;

                return (
                  <div key={issue.id} className="flex flex-col">
                    <Link
                      href={isAvailable ? `/book/${bookId}/${issue.id}/1` : "#"}
                      className={`group flex flex-col transition-transform ${
                        isAvailable
                          ? "cursor-pointer hover:scale-105"
                          : "cursor-not-allowed opacity-50"
                      }`}
                    >
                      <div className="relative mb-2 aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-800 shadow-lg">
                        {isAvailable ? (
                          <Image
                            src={issueCoverImage}
                            alt={`${book.name} - ${issue.name}`}
                            fill
                            className="object-cover transition-opacity group-hover:opacity-80"
                            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, (max-width: 1280px) 20vw, 16vw"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-gray-500">
                            Not Available
                          </div>
                        )}
                      </div>
                      <h3 className="text-center text-sm font-semibold">
                        {issue.name}
                      </h3>
                      <div className="mt-1 text-center text-xs text-gray-400">
                        {issue.pageCount} pages
                        {issue.hasAudio && (
                          <span className="ml-2 text-green-400">• Audio</span>
                        )}
                      </div>
                    </Link>
                    {offlineUrlsByIssue[issue.id] &&
                      offlineUrlsByIssue[issue.id]!.length > 0 && (
                        <div className="mt-2">
                          <OfflineDownload
                            urls={offlineUrlsByIssue[issue.id]!}
                            label={`${book.name} ${issue.name}`}
                          />
                        </div>
                      )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
