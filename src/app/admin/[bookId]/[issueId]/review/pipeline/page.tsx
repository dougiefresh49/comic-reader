import Link from "next/link";
import { notFound } from "next/navigation";
import { getPipelineReviewIssue } from "~/server/admin/pipeline-review";
import { getPipelineProgress } from "~/server/admin/pipeline-progress";
import { PipelineActions } from "~/app/admin/PipelineActions";
import { LiveRefresh } from "./LiveRefresh";
import { LocalTime } from "./LocalTime";
import { Stages } from "./StageList";
import { formatAgo, formatDuration } from "./format";
import { buildHubView, RUN_WORDS, STATE_LABELS, type RunState } from "./model";
import { stepLabel } from "./stages";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

export default async function PipelineReviewPage({ params }: Params) {
  const { bookId, issueId } = await params;
  const [issue, progress] = await Promise.all([
    getPipelineReviewIssue(bookId, issueId),
    getPipelineProgress(bookId, issueId),
  ]);
  if (!issue) notFound();

  const now = Date.now();
  const view = buildHubView(issue, progress.run, progress.counts, now);
  const { run } = progress;

  const gateHref =
    view.state === "waiting" && issue.pipelinePausedUrl
      ? toRelativeHref(issue.pipelinePausedUrl)
      : null;

  const reviewLinks = reviewPages(bookId, issueId, issue.hasWebP);

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <LiveRefresh intervalMs={view.refreshMs} />
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center justify-between text-sm">
          <Link
            href="/admin"
            className="text-neutral-400 hover:text-neutral-200"
          >
            &larr; Admin
          </Link>
          <span className="text-neutral-500">
            {bookId} / {issueId}
          </span>
        </div>

        <p className="text-sm text-neutral-400">{issue.bookName}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {issue.number}. {issue.name}
        </h1>

        <section
          aria-label="Run status"
          className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/60"
        >
          <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-5">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <StateDot state={view.state} />
                <h2 className="text-xl font-medium">
                  {STATE_LABELS[view.state]}
                </h2>
              </div>
              <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-neutral-400">
                {view.summary}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <PipelineActions
                bookId={issue.bookId}
                issueId={issue.issueId}
                pipelineStep={issue.pipelineStep}
                pipelinePaused={issue.pipelinePaused}
                pipelinePausedAt={issue.pipelinePausedAt}
                pipelinePausedUrl={issue.pipelinePausedUrl}
                pageCount={issue.pageCount}
                status={issue.status}
                skippedGates={run?.status === "running" ? run.skipped : []}
              />
              {view.refreshMs !== null && (
                <span className="text-sm text-neutral-500">
                  refreshes every {view.refreshMs / 1000} s
                </span>
              )}
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-neutral-800 px-5 py-4 text-sm sm:grid-cols-4">
            <Fact label="Started">
              {view.startedAt ? (
                <>
                  <LocalTime iso={view.startedAt} />
                  <span className="ml-2 text-neutral-500">
                    {formatAgo(view.startedAt, now)}
                  </span>
                </>
              ) : (
                <span className="text-neutral-500">no run recorded</span>
              )}
            </Fact>
            <Fact label="Duration">
              {view.durationMs !== null ? (
                formatDuration(view.durationMs)
              ) : (
                <span className="text-neutral-500">&mdash;</span>
              )}
            </Fact>
            <Fact label="Current step">
              {view.currentLabel ?? (
                <span className="text-neutral-500">
                  {view.state === "ready" ? "all done" : "none"}
                </span>
              )}
            </Fact>
            <Fact label="Run">
              {run ? (
                <>
                  {RUN_WORDS[view.state]}
                  {run.fromStep && (
                    <span className="ml-2 text-neutral-500">
                      from {stepLabel(run.fromStep)}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-neutral-500">&mdash;</span>
              )}
            </Fact>
          </dl>

          {view.state === "waiting" && (
            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-amber-400/20 bg-amber-400/5 px-5 py-4">
              <p className="text-sm text-amber-100">
                Your turn: finish {view.currentLabel}, then press Resume above.
              </p>
              {gateHref ? (
                <a
                  href={gateHref}
                  className="inline-flex h-9 items-center rounded-md bg-amber-400 px-4 text-sm font-medium text-neutral-950 hover:bg-amber-300"
                >
                  Open {view.currentLabel} &rarr;
                </a>
              ) : (
                <span className="text-sm text-amber-200/80">
                  The run recorded no page for this gate.
                </span>
              )}
            </div>
          )}

          {view.state === "failed" && (
            <div className="border-t border-red-400/20 bg-red-400/5 px-5 py-4 text-sm">
              <p className="text-red-100">
                Failed at{" "}
                <span className="font-medium">{view.currentLabel}</span>.
              </p>
              <p className="mt-1 text-red-200/80">
                {run?.error ??
                  "The run recorded no error message. The Workflow run log has the stack."}
              </p>
            </div>
          )}
        </section>

        <section aria-labelledby="stages-heading" className="mt-10">
          <h2
            id="stages-heading"
            className="mb-3 text-sm font-medium tracking-wide text-neutral-500 uppercase"
          >
            Stages
          </h2>
          <Stages stages={view.stages} />
          {run?.fromStep && (
            <p className="mt-3 text-sm text-neutral-500">
              This run started from {stepLabel(run.fromStep)}. Steps before it
              keep their rows from earlier runs and show no duration here.
            </p>
          )}
          {!run && view.state !== "not-started" && (
            <p className="mt-3 text-sm text-neutral-500">
              No run row for this issue, so no step durations. The counts are
              live.
            </p>
          )}
        </section>

        <section aria-labelledby="review-heading" className="mt-10">
          <h2
            id="review-heading"
            className="mb-3 text-sm font-medium tracking-wide text-neutral-500 uppercase"
          >
            Review pages, in pipeline order
          </h2>
          <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800 bg-neutral-900/40">
            {reviewLinks.map((item) => (
              <li
                key={item.label}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3"
              >
                {item.href ? (
                  <Link
                    href={item.href}
                    className="text-base font-medium text-neutral-100 underline-offset-4 hover:underline"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span className="text-base font-medium text-neutral-500">
                    {item.label}
                  </span>
                )}
                <span className="text-sm text-neutral-400">{item.note}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="mt-0.5 text-neutral-200">{children}</dd>
    </div>
  );
}

const STATE_DOT: Record<RunState, string> = {
  running: "bg-cyan-400",
  waiting: "bg-amber-400",
  failed: "bg-red-500",
  cancelled: "bg-neutral-400",
  ready: "bg-emerald-400",
  "not-started": "bg-neutral-600",
};

function StateDot({ state }: { state: RunState }) {
  return (
    <span className="relative flex size-3 shrink-0">
      {state === "running" && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-cyan-400/50" />
      )}
      <span
        className={`relative inline-flex size-3 rounded-full ${STATE_DOT[state]}`}
      />
    </span>
  );
}

/**
 * The gate URL is stored absolute to whatever host wrote it (localhost in a
 * dev run, the Vercel host in prod). Keep the path, query and hash, drop the
 * host, so the link opens on the host the hub is served from.
 */
function toRelativeHref(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}

function reviewPages(bookId: string, issueId: string, hasWebP: boolean) {
  const base = `/admin/${bookId}/${issueId}/review`;
  const q = `book=${encodeURIComponent(bookId)}&issue=${encodeURIComponent(issueId)}`;
  return [
    {
      label: "Character clusters",
      href: `${base}/clusters`,
      note: "Name the faces the run could not place. The Characters gate.",
    },
    {
      label: "Speakers",
      href: `${base}/speakers`,
      note: "Fix unknown speakers after Get context.",
    },
    {
      label: "Panels",
      href: `${base}/panels`,
      note: "Panel bounds, effects and bubble assignment.",
    },
    {
      label: "Pages in the reader",
      href: hasWebP ? `${base}/bubbles?mode=pipeline` : null,
      note: hasWebP
        ? "Karaoke-style text review. The Pages gate."
        : "Karaoke-style text review. Opens once the WebP pages are published.",
    },
    {
      label: "Review editor",
      href: `${base}/editor`,
      note: "Panels and bubbles in one workbench; edits stay in the browser.",
    },
    {
      label: "New characters",
      href: `${base}/new-characters`,
      note: "Aliases or new roles before any voice is made.",
    },
    {
      label: "Casting",
      href: `/admin/characters/casting?${q}`,
      note: "Voice sources and clips. The Casting gate.",
    },
    {
      label: "Voices",
      href: "/admin/voices",
      note: "ElevenLabs slots and PVC tools, across every book.",
    },
    {
      label: "Scenes",
      href: `${base}/scenes`,
      note: "Music scene boundaries after the run completes.",
    },
  ];
}
