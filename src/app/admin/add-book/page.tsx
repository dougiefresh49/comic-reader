import { AddBookClient } from "./AddBookClient";

export const dynamic = "force-dynamic";

export default function AddBookPage() {
  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-2 text-2xl font-semibold">Add New Book</h1>
        <p className="mb-8 text-sm text-neutral-400">
          Search for a comic series to add to your library. We&apos;ll pull
          metadata from the wiki and set up the book record.
        </p>
        <AddBookClient />
      </div>
    </main>
  );
}
