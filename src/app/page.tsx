import Link from "next/link";
import Image from "next/image";
import manifest from "~/data/manifest";

export default function LibraryPage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
      <div className="container mx-auto px-4 py-8">
        <h1 className="mb-8 text-4xl font-bold tracking-tight sm:text-5xl">
          Comic Library
        </h1>

        {manifest.books.length === 0 ? (
          <div className="text-center text-gray-400">
            <p>No books available yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {manifest.books.map((book) => {
              // Use first page of first issue as cover
              const firstIssue = book.issues[0];
              const coverImage = firstIssue
                ? `/comics/tmnt-mmpr-iii/${firstIssue.id}/pages/page-01.webp`
                : null;

              return (
                <Link
                  key={book.id}
                  href={`/book/${book.id}`}
                  className="group flex flex-col items-center transition-transform hover:scale-105"
                >
                  <div className="relative mb-2 aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-800 shadow-lg">
                    {coverImage ? (
                      <Image
                        src={coverImage}
                        alt={book.name}
                        fill
                        className="object-cover transition-opacity group-hover:opacity-80"
                        sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, (max-width: 1280px) 20vw, 16vw"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-gray-500">
                        No Cover
                      </div>
                    )}
                  </div>
                  <h2 className="text-center text-sm font-semibold">
                    {book.name}
                  </h2>
                  <p className="mt-1 text-center text-xs text-gray-400">
                    {book.issues.length} issue
                    {book.issues.length !== 1 ? "s" : ""}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
