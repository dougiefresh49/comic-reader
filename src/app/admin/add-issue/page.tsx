import { supabaseAdmin } from "~/lib/supabase-admin";
import { getBookInfo } from "./actions";
import { AddIssueClient } from "./AddIssueClient";

export const dynamic = "force-dynamic";

export default async function AddIssuePage({
  searchParams,
}: {
  searchParams: Promise<{ book?: string }>;
}) {
  const { book: bookId } = await searchParams;

  if (!bookId) {
    const { data: books } = await supabaseAdmin
      .from("books")
      .select("id, name")
      .order("name", { ascending: true });

    return (
      <main className="min-h-screen bg-neutral-950 px-6 py-8 text-neutral-100">
        <div className="mx-auto max-w-3xl">
          <h1 className="mb-6 text-2xl font-bold">Add Issue</h1>
          <p className="mb-4 text-neutral-400">
            Select a book to add an issue to:
          </p>
          <div className="flex flex-col gap-2">
            {(books ?? []).map((b) => (
              <a
                key={b.id}
                href={`/admin/add-issue?book=${b.id}`}
                className="rounded-lg bg-neutral-800 px-4 py-3 text-neutral-100 transition-colors hover:bg-neutral-700"
              >
                {b.name}
              </a>
            ))}
          </div>
        </div>
      </main>
    );
  }

  const result = await getBookInfo(bookId);

  if (!result.ok) {
    return (
      <main className="min-h-screen bg-neutral-950 px-6 py-8 text-neutral-100">
        <div className="mx-auto max-w-3xl">
          <h1 className="mb-6 text-2xl font-bold">Add Issue</h1>
          <p className="text-red-400">Error: {result.error}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-8 text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <AddIssueClient
          bookInfo={{
            id: bookId,
            name: result.data.name,
            totalIssues: result.data.totalIssues,
            parts: result.data.parts,
            nextIssueNumber: result.data.nextIssueNumber,
            wikiTitleTemplate: result.data.wikiTitleTemplate,
            wikiHost: result.data.wikiHost,
          }}
        />
      </div>
    </main>
  );
}
