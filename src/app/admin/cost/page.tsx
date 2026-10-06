import Link from "next/link";
import { CostReport, loadCalls } from "./cost-report";

export const dynamic = "force-dynamic";

export default async function OtherCostsPage() {
  const rows = await loadCalls({ noBook: true });

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-center justify-between">
          <Link
            href="/admin"
            className="text-sm text-neutral-400 hover:text-neutral-200"
          >
            &larr; Admin
          </Link>
        </div>

        <h1 className="mb-2 text-2xl font-semibold">Other costs</h1>
        <p className="mb-6 text-sm text-neutral-400">
          Paid calls recorded with no book or issue: the Add Book search, the
          Add Issue source search, and audio library sounds and music. Each
          issue&apos;s own calls are on its Cost page. Credits are what
          ElevenLabs charges on its subscription, read from the response charge
          or estimated from characters and a per-model rate. Dollar figures are
          estimates from the rates in the code, not the invoice. The Add Book
          and Add Issue searches are priced from tokens only: any fee Google
          adds for a search-grounded call is not in them.
        </p>

        <CostReport rows={rows} totalLabel="Total" />
      </div>
    </main>
  );
}
