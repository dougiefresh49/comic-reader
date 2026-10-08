import { notFound } from "next/navigation";
import Link from "next/link";
import { getManifest } from "~/server";
import { monogram } from "~/lib/monogram";
import { pageImageUrl } from "~/lib/storage";
import { getIssueOfflineUrls } from "~/server/offline";
import { IssueGrid, MetaChip } from "~/components/IssueCards";
import { CoverImage } from "~/components/ui/CoverImage";

interface SeriesDetailProps {
  params: Promise<{
    seriesId: string;
  }>;
}

export default async function SeriesDetailPage({ params }: SeriesDetailProps) {
  const { seriesId } = await params;

  const manifest = await getManifest({ publishedOnly: true });

  // The series and its published books, lowest position first
  const series = manifest.series.find((s) => s.id === seriesId);
  if (!series) {
    notFound();
  }

  // Offline URL lists for each available issue, keyed by book then issue.
  // Empty for not-yet-ingested issues. ~50 URLs/issue, fast.
  const offlineUrlsByBook: Record<string, Record<string, string[]>> = {};
  await Promise.all(
    series.books.flatMap((book) => {
      const byIssue: Record<string, string[]> = {};
      offlineUrlsByBook[book.id] = byIssue;
      return book.issues
        .filter((i) => i.hasWebP)
        .map(async (issue) => {
          byIssue[issue.id] = await getIssueOfflineUrls(
            book.id,
            issue.id,
            issue.pageCount,
          );
        });
    }),
  );

  // Cover image: first page of the first issue of the first book
  const firstBook = series.books[0];
  const firstIssue = firstBook?.issues[0];
  const coverImage =
    firstBook && firstIssue
      ? pageImageUrl(firstBook.id, firstIssue.id, 1)
      : null;
  const issueCount = series.books.reduce((n, b) => n + b.issues.length, 0);
  const hasVoiceActing = series.books.some((book) =>
    book.issues.some((issue) => issue.hasAudio),
  );

  return (
    <main className="relative min-h-screen bg-neutral-950 text-neutral-100">
      {/* Subtle cyan glow at the top, matching the reader chrome */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(34,211,238,0.08),transparent)]"
      />

      <div className="relative container mx-auto px-4 py-10">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-1.5 rounded-full text-sm text-neutral-400 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:outline-none"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
          Back to Library
        </Link>

        {/* Hero row */}
        <div className="mb-12 flex flex-col gap-6 sm:flex-row sm:items-end">
          <div className="w-40 shrink-0 md:w-52">
            <div className="relative aspect-[2/3] overflow-hidden rounded-2xl border border-white/10 bg-neutral-900">
              <CoverImage
                src={coverImage}
                alt={series.name}
                fallbackLabel={monogram(series.name)}
                sizes="208px"
                priority
              />
            </div>
          </div>

          <div className="flex flex-col gap-3 pb-1">
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              {series.name}
            </h1>
            <div className="flex flex-wrap gap-2">
              <MetaChip>
                <span className="tabular-nums">{issueCount}</span> issue
                {issueCount !== 1 ? "s" : ""}
              </MetaChip>
              {hasVoiceActing ? (
                <MetaChip>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" x2="12" y1="19" y2="22" />
                  </svg>
                  Voice acted
                </MetaChip>
              ) : null}
            </div>
          </div>
        </div>

        {/* One section per book (volume), in series order */}
        <div className="space-y-12">
          {series.books.map((book) => (
            <section key={book.id}>
              <h2 className="mb-4 text-xs font-semibold tracking-[0.08em] text-neutral-500 uppercase">
                {book.name}
              </h2>
              <IssueGrid
                bookId={book.id}
                bookName={book.name}
                issues={book.issues}
                offlineUrlsByIssue={offlineUrlsByBook[book.id] ?? {}}
              />
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
