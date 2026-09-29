import Link from "next/link";
import { notFound } from "next/navigation";
import { selectIssue } from "~/lib/issue-queries";
import { supabaseAdmin } from "~/lib/supabase-admin";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

type CallRow = {
  step: string | null;
  model: string | null;
  ok: boolean | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_thinking: number | null;
  characters: number | null;
  usd_est: number | string | null;
};

type Rollup = {
  step: string;
  model: string;
  calls: number;
  failed: number;
  tokensIn: number;
  tokensOut: number;
  tokensThinking: number;
  characters: number;
  usd: number;
};

const PAGE_SIZE = 1000;

/** Every `llm_calls` row for the issue, paged past PostgREST's row cap. */
async function loadCalls(bookId: string, issueId: string) {
  const rows: CallRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("llm_calls")
      .select(
        "step, model, ok, tokens_in, tokens_out, tokens_thinking, characters, usd_est",
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .order("created_at")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`llm_calls read failed: ${error.message}`);
    rows.push(...((data ?? []) as CallRow[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

function rollUp(rows: CallRow[]): Rollup[] {
  const groups = new Map<string, Rollup>();
  for (const r of rows) {
    const step = r.step ?? "(none)";
    const model = r.model ?? "(none)";
    const key = `${step}\u0000${model}`;
    const g = groups.get(key) ?? {
      step,
      model,
      calls: 0,
      failed: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensThinking: 0,
      characters: 0,
      usd: 0,
    };
    g.calls++;
    if (r.ok === false) g.failed++;
    g.tokensIn += r.tokens_in ?? 0;
    g.tokensOut += r.tokens_out ?? 0;
    g.tokensThinking += r.tokens_thinking ?? 0;
    g.characters += r.characters ?? 0;
    g.usd += Number(r.usd_est ?? 0);
    groups.set(key, g);
  }
  return [...groups.values()].sort(
    (a, b) => a.step.localeCompare(b.step) || a.model.localeCompare(b.model),
  );
}

const num = (n: number) => n.toLocaleString("en-US");
const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 5 : 2)}`;

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

  const groups = rollUp(await loadCalls(bookId, issueId));
  const total = groups.reduce((s, g) => s + g.usd, 0);
  const totalCalls = groups.reduce((s, g) => s + g.calls, 0);

  const cell = "px-4 py-2 text-neutral-300";
  const numCell = `${cell} text-right tabular-nums`;

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
          step and model. Dollar figures are estimates from the rates in the
          code, not the invoice.
        </p>

        <div className="mb-6 rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-sm">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-neutral-300">
            <span>
              <span className="text-neutral-500">Issue total </span>
              {usd(total)}
            </span>
            <span>
              <span className="text-neutral-500">Calls </span>
              {num(totalCalls)}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full">
            <thead className="bg-neutral-900 text-xs text-neutral-400 uppercase">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Step</th>
                <th className="px-4 py-2 text-left font-medium">Model</th>
                <th className="px-4 py-2 text-right font-medium">Calls</th>
                <th className="px-4 py-2 text-right font-medium">Failed</th>
                <th className="px-4 py-2 text-right font-medium">Tokens in</th>
                <th className="px-4 py-2 text-right font-medium">Tokens out</th>
                <th className="px-4 py-2 text-right font-medium">Thinking</th>
                <th className="px-4 py-2 text-right font-medium">Characters</th>
                <th className="px-4 py-2 text-right font-medium">Est. $</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800 text-sm">
              {groups.length === 0 ? (
                <tr>
                  <td className={cell} colSpan={9}>
                    0 calls
                  </td>
                </tr>
              ) : (
                groups.map((g) => (
                  <tr key={`${g.step}/${g.model}`}>
                    <td className={cell}>{g.step}</td>
                    <td className="px-4 py-2 text-neutral-400">{g.model}</td>
                    <td className={numCell}>{num(g.calls)}</td>
                    <td className={numCell}>{num(g.failed)}</td>
                    <td className={numCell}>{num(g.tokensIn)}</td>
                    <td className={numCell}>{num(g.tokensOut)}</td>
                    <td className={numCell}>{num(g.tokensThinking)}</td>
                    <td className={numCell}>{num(g.characters)}</td>
                    <td className={numCell}>{usd(g.usd)}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot className="border-t border-neutral-700 text-sm font-medium">
              <tr>
                <td className={cell} colSpan={2}>
                  Issue total
                </td>
                <td className={numCell}>{num(totalCalls)}</td>
                <td className={numCell} colSpan={5} />
                <td className={numCell}>{usd(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </main>
  );
}
