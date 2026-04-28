import Link from "next/link";
import { getCastingTasks } from "~/server/admin/casting";
import { CastingClient } from "./CastingClient";

export const dynamic = "force-dynamic";

interface SearchParams {
  searchParams: Promise<{ book?: string; issue?: string }>;
}

export default async function CastingPage({ searchParams }: SearchParams) {
  const sp = await searchParams;
  const tasks = await getCastingTasks(sp.book, sp.issue);

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-center justify-between">
          <Link
            href="/admin"
            className="text-sm text-neutral-400 hover:text-neutral-200"
          >
            ← Admin
          </Link>
          <span className="text-xs text-neutral-500">
            {sp.book ? `${sp.book}` : "all books"}
            {sp.issue ? ` / ${sp.issue}` : ""}
          </span>
        </div>
        <h1 className="mb-2 text-2xl font-semibold">Casting</h1>
        <p className="mb-8 text-sm text-neutral-400">
          Source voice clips and create ElevenLabs voice models for characters.
        </p>

        {tasks.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-sm text-neutral-400">
            No pending casting tasks. Run{" "}
            <code className="rounded bg-neutral-800 px-1.5 py-0.5">
              pnpm find-voice-sources -- --book &lt;name&gt; --issue &lt;n&gt;
              --db
            </code>{" "}
            to populate.
          </div>
        ) : (
          <CastingClient initialTasks={tasks} />
        )}
      </div>
    </main>
  );
}
