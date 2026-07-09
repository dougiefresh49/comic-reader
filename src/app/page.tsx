import Link from "next/link";
import { getManifest } from "~/server";
import { pageImageUrl } from "~/lib/storage";
import { CoverImage } from "~/components/ui/CoverImage";
import type { BookManifest } from "~/types/manifest";

export const revalidate = 3600;

/** "TMNT x MMPR" → "TM" — short monogram for cover placeholders. */
function monogram(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

function bookCover(book: BookManifest): string | null {
  const firstIssue = book.issues[0];
  return firstIssue ? pageImageUrl(book.id, firstIssue.id, 1) : null;
}

export default async function LibraryPage() {
  const manifest = await getManifest();
  const books = manifest.books;

  return (
    <main className="relative min-h-screen bg-neutral-950 text-neutral-100">
      {/* Subtle cyan glow at the top, matching the reader chrome */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(34,211,238,0.08),transparent)]"
      />

      <div className="relative container mx-auto px-4 py-10">
        <header className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Comic Library
          </h1>
          <p className="mt-2 text-sm text-neutral-400 sm:text-base">
            Tap a bubble. Hear the story.
          </p>
        </header>

        {books.length === 0 ? (
          <EmptyLibrary />
        ) : books.length <= 2 ? (
          <FeaturedBooks books={books} />
        ) : (
          <BookGrid books={books} />
        )}
      </div>
    </main>
  );
}

/** Centered hero treatment for a 1–2 book library. */
function FeaturedBooks({ books }: { books: BookManifest[] }) {
  return (
    <div className="flex flex-wrap items-start justify-center gap-8 pt-4 sm:pt-8">
      {books.map((book) => (
        <Link
          key={book.id}
          href={`/book/${book.id}`}
          className="group flex w-60 flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 p-3 transition hover:bg-white/10 hover:ring-2 hover:ring-cyan-400/60 focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:outline-none sm:w-72"
        >
          <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-neutral-900">
            <CoverImage
              src={bookCover(book)}
              alt={book.name}
              fallbackLabel={monogram(book.name)}
              sizes="288px"
              priority
              className="transition-transform duration-300 group-hover:scale-[1.02]"
            />
          </div>
          <div className="flex items-center justify-between gap-3 px-1 pb-1">
            <h2 className="text-sm font-semibold text-neutral-100">
              {book.name}
            </h2>
            <IssueCountChip count={book.issues.length} />
          </div>
        </Link>
      ))}
    </div>
  );
}

/** Standard grid for 3+ books. */
function BookGrid({ books }: { books: BookManifest[] }) {
  return (
    <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {books.map((book) => (
        <Link
          key={book.id}
          href={`/book/${book.id}`}
          className="group flex flex-col gap-2 rounded-2xl border border-white/10 bg-white/5 p-2.5 transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:outline-none"
        >
          <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-neutral-900">
            <CoverImage
              src={bookCover(book)}
              alt={book.name}
              fallbackLabel={monogram(book.name)}
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, (max-width: 1280px) 20vw, 16vw"
              className="transition-transform duration-300 group-hover:scale-[1.02]"
            />
          </div>
          <div className="px-1 pb-1">
            <h2 className="line-clamp-2 text-sm font-semibold text-neutral-100">
              {book.name}
            </h2>
            <p className="mt-1 text-xs text-neutral-500 tabular-nums">
              {book.issues.length} issue{book.issues.length !== 1 ? "s" : ""}
            </p>
          </div>
        </Link>
      ))}
    </div>
  );
}

function IssueCountChip({ count }: { count: number }) {
  return (
    <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs text-neutral-400 tabular-nums">
      {count} issue{count !== 1 ? "s" : ""}
    </span>
  );
}

function EmptyLibrary() {
  return (
    <div className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-8 py-12 text-center">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="36"
        height="36"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-neutral-500"
        aria-hidden
      >
        <path d="M12 7v14" />
        <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
      </svg>
      <h2 className="text-sm font-semibold text-neutral-100">No books yet</h2>
      <p className="text-xs text-neutral-400">
        Ingest a comic and it will show up here, ready to read aloud.
      </p>
    </div>
  );
}
