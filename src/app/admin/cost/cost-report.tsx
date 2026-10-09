import { supabaseAdmin } from "~/lib/supabase-admin";

type CallRow = {
  provider: string;
  step: string | null;
  model: string | null;
  ok: boolean | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_thinking: number | null;
  characters: number | null;
  credits: number | string | null;
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
  /** Sum of `credits`. Zero on a group where no row carries one (Gemini). */
  credits: number;
  /** Whether any row in the group has a credits figure at all (#251). */
  hasCredits: boolean;
  missingCredits: number;
  usd: number;
  /** Successful calls with no `usd_est` (no rate for the model): not in `usd`. */
  missingUsd: number;
};

/** One issue's calls (both ids, as every `issues` read needs), or the calls with no book. */
export type CallFilter = { bookId: string; issueId: string } | { noBook: true };

const PAGE_SIZE = 1000;

/** Every `llm_calls` row the filter selects, paged past PostgREST's row cap. */
export async function loadCalls(filter: CallFilter) {
  const rows: CallRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const base = supabaseAdmin
      .from("llm_calls")
      .select(
        "provider, step, model, ok, tokens_in, tokens_out, tokens_thinking, characters, credits, usd_est",
      );
    const filtered =
      "noBook" in filter
        ? base.is("book_id", null)
        : base.eq("book_id", filter.bookId).eq("issue_id", filter.issueId);
    const { data, error } = await filtered
      .order("created_at")
      .order("id")
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
      credits: 0,
      hasCredits: false,
      missingCredits: 0,
      usd: 0,
      missingUsd: 0,
    };
    g.calls++;
    if (r.ok === false) g.failed++;
    g.tokensIn += r.tokens_in ?? 0;
    g.tokensOut += r.tokens_out ?? 0;
    g.tokensThinking += r.tokens_thinking ?? 0;
    g.characters += r.characters ?? 0;
    if (r.credits != null) {
      g.credits += Number(r.credits);
      g.hasCredits = true;
    }
    if (r.provider === "elevenlabs" && r.ok === true && r.credits == null) {
      g.missingCredits++;
    }
    if (r.usd_est != null) g.usd += Number(r.usd_est);
    else if (r.ok !== false) g.missingUsd++;
    groups.set(key, g);
  }
  return [...groups.values()].sort(
    (a, b) => a.step.localeCompare(b.step) || a.model.localeCompare(b.model),
  );
}

const num = (n: number) => n.toLocaleString("en-US");
const creditsLabel = (credits: number, hasCredits: boolean, missing: number) =>
  missing > 0
    ? `${num(credits)} (partial; ${num(missing)} ${missing === 1 ? "call" : "calls"} missing credits)`
    : hasCredits
      ? num(credits)
      : "n/a";
const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 5 : 2)}`;
const usdLabel = (n: number, missing: number) =>
  missing > 0
    ? `${usd(n)} (partial; ${num(missing)} ${missing === 1 ? "call" : "calls"} missing an estimate)`
    : usd(n);

/** The summary bar and the step-by-model table over `rows`. */
export function CostReport({
  rows,
  totalLabel,
}: {
  rows: CallRow[];
  totalLabel: string;
}) {
  const groups = rollUp(rows);
  const total = groups.reduce((s, g) => s + g.usd, 0);
  const totalCalls = groups.reduce((s, g) => s + g.calls, 0);
  const totalCredits = groups.reduce((s, g) => s + g.credits, 0);
  const missingCredits = groups.reduce((s, g) => s + g.missingCredits, 0);
  const anyCredits = groups.some((g) => g.hasCredits);
  const missingUsd = groups.reduce((s, g) => s + g.missingUsd, 0);

  const cell = "px-4 py-2 text-neutral-300";
  const numCell = `${cell} text-right tabular-nums`;

  return (
    <>
      <div className="mb-6 rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-sm">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-neutral-300">
          <span>
            <span className="text-neutral-500">{totalLabel} </span>
            {usdLabel(total, missingUsd)}
          </span>
          {anyCredits || missingCredits > 0 ? (
            <span>
              <span className="text-neutral-500">Credits </span>
              {creditsLabel(totalCredits, anyCredits, missingCredits)}
            </span>
          ) : null}
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
              <th className="px-4 py-2 text-right font-medium">Credits</th>
              <th className="px-4 py-2 text-right font-medium">Est. $</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800 text-sm">
            {groups.length === 0 ? (
              <tr>
                <td className={cell} colSpan={10}>
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
                  <td className={numCell}>
                    {creditsLabel(g.credits, g.hasCredits, g.missingCredits)}
                  </td>
                  <td className={numCell}>{usdLabel(g.usd, g.missingUsd)}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot className="border-t border-neutral-700 text-sm font-medium">
            <tr>
              <td className={cell} colSpan={2}>
                {totalLabel}
              </td>
              <td className={numCell}>{num(totalCalls)}</td>
              <td className={numCell} colSpan={5} />
              <td className={numCell}>
                {creditsLabel(totalCredits, anyCredits, missingCredits)}
              </td>
              <td className={numCell}>{usdLabel(total, missingUsd)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
