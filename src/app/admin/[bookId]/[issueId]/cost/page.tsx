import Link from "next/link";
import { notFound } from "next/navigation";
import { CostReport, loadCalls } from "~/app/admin/cost/cost-report";
import { selectIssue } from "~/lib/issue-queries";
import { supabaseAdmin } from "~/lib/supabase-admin";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

export default async function IssueCostPage({ params }: Params) {
  const { bookId, issueId } = await params;
  const { data: issue, error: issueErr } = await selectIssue(
    supabaseAdmin,
    bookId,
    issueId,
    "number, name",
  ).maybeSingle();
  if (issueErr) throw new Error(`issues read failed: ${issueErr.message}`);
  if (!issue) notFound();

  const rows = await loadCalls({ bookId, issueId });

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
          <span className="text-xs text-neutral-500">
            {bookId} / {issueId}
          </span>
        </div>

        <h1 className="mb-2 text-2xl font-semibold">Cost</h1>
        <p className="mb-6 text-sm text-neutral-400">
          {issue.number}. {issue.name}. Recorded Gemini and ElevenLabs calls by
          step and model. Credits are what ElevenLabs charges on its
          subscription, read from the response charge or estimated from
          characters and a per-model rate. Dollar figures are estimates from the
          rates in the code, not the invoice.
        </p>

        <CostReport rows={rows} totalLabel="Issue total" />
      </div>
    </main>
  );
}
