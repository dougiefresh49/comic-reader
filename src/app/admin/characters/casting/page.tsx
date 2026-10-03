// The old casting page (#353): with a book and issue it is the voices stop; without, a list of issues with open voice work.
import Link from "next/link";
import { redirect } from "next/navigation";
import { issuesWithVoiceWork } from "~/server/admin/casting";

export const dynamic = "force-dynamic";

interface SearchParams {
  searchParams: Promise<{ book?: string; issue?: string }>;
}

const voicesStop = (bookId: string, issueId: string) =>
  `/admin/${encodeURIComponent(bookId)}/${encodeURIComponent(issueId)}/review/characters/voices`;

export default async function CastingPage({ searchParams }: SearchParams) {
  const sp = await searchParams;
  if (sp.book && sp.issue) redirect(voicesStop(sp.book, sp.issue));

  const issues = await issuesWithVoiceWork();
  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/admin"
          className="text-[14px] text-neutral-400 hover:text-neutral-200"
        >
          ← Admin
        </Link>
        <h1 className="mt-6 mb-2 text-2xl font-semibold">Voices</h1>
        <p className="mb-8 text-[14px] text-neutral-400">
          Each issue&apos;s voice work is on its voices stop.
        </p>
        {issues.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-800 px-4 py-6 text-center text-neutral-500">
            No issue has open voice work.
          </p>
        ) : (
          <ul className="space-y-2">
            {issues.map((i) => (
              <li key={`${i.bookId}/${i.issueId}`}>
                <Link
                  href={voicesStop(i.bookId, i.issueId)}
                  className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900/60 px-4 py-3 hover:border-neutral-600"
                >
                  <span>
                    {i.bookId} / {i.issueId}
                  </span>
                  <span className="text-neutral-400">{i.open} open</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
