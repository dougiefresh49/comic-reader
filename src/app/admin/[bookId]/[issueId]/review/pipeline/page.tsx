import Link from "next/link";
import { notFound } from "next/navigation";
import { getPipelineReviewIssue } from "~/server/admin/pipeline-review";
import { TriggerIngestButton } from "~/app/admin/TriggerIngestButton";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
}

export default async function PipelineReviewPage({ params }: Params) {
  const { bookId, issueId } = await params;
  const issue = await getPipelineReviewIssue(bookId, issueId);
  if (!issue) notFound();

  const canTrigger =
    issue.pageCount > 0 &&
    (issue.pipelineStep === "pages-downloaded" ||
      issue.pipelineStep?.startsWith("failed:"));

  const resumeHref =
    issue.pipelinePaused && issue.pipelinePausedUrl
      ? issue.pipelinePausedUrl
      : null;

  const issueLabel = `${issue.number}. ${issue.name}`;

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-10 text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <Link
            href="/admin"
            className="text-sm text-neutral-400 hover:text-neutral-200"
          >
            ← Admin
          </Link>
          <span className="text-xs text-neutral-500">
            {bookId} / {issueId}
          </span>
        </div>

        <h1 className="mb-2 text-2xl font-semibold">Pipeline review</h1>
        <p className="mb-2 text-sm text-neutral-400">
          {issueLabel} — human-in-the-loop steps and tooling while the ingest
          worker runs.
        </p>

        <div className="mb-8 rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-sm">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-neutral-300">
            <span>
              <span className="text-neutral-500">Step </span>
              {issue.pipelineStep ?? "—"}
            </span>
            <span>
              <span className="text-neutral-500">Status </span>
              {issue.status}
            </span>
            {issue.pipelinePaused && issue.pipelinePausedAt && (
              <span className="text-yellow-200/90">
                Paused at {issue.pipelinePausedAt}
              </span>
            )}
          </div>
          {issue.pipelinePaused && resumeHref && (
            <Link
              href={resumeHref}
              className="mt-3 inline-flex rounded bg-yellow-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-600"
            >
              Open blocking review →
            </Link>
          )}
          {canTrigger && (
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-neutral-800 pt-4">
              <span className="text-xs text-neutral-500">
                Pages are ready but the pipeline hasn&apos;t been queued (or
                failed and can restart).
              </span>
              <TriggerIngestButton
                bookId={issue.bookId}
                issueId={issue.issueId}
              />
            </div>
          )}
        </div>

        <h2 className="mb-3 text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Review &amp; tools
        </h2>
        <ul className="space-y-2 text-sm">
          <li>
            <Link
              href={`/admin/${bookId}/${issueId}/review/speakers`}
              className="text-cyan-400 hover:text-cyan-300"
            >
              Speakers
            </Link>
            <span className="ml-2 text-neutral-600">
              — correct unknown speakers after context
            </span>
          </li>
          <li>
            <Link
              href={`/admin/${bookId}/${issueId}/review/new-characters`}
              className="text-cyan-400 hover:text-cyan-300"
            >
              New characters
            </Link>
            <span className="ml-2 text-neutral-600">
              — aliases vs new roles before voice sourcing
            </span>
          </li>
          <li>
            <Link
              href={`/admin/${bookId}/${issueId}/review/clusters`}
              className="text-cyan-400 hover:text-cyan-300"
            >
              Character clusters
            </Link>
            <span className="ml-2 text-neutral-600">
              — face cluster review (stub)
            </span>
          </li>
          <li>
            <Link
              href={`/admin/${bookId}/${issueId}/review/panels`}
              className="text-fuchsia-400 hover:text-fuchsia-300"
            >
              Panels
            </Link>
            <span className="ml-2 text-neutral-600">
              — panel bounds, effects, bubble assignment
            </span>
          </li>
          <li>
            <Link
              href={`/admin/characters/casting?book=${encodeURIComponent(bookId)}&issue=${encodeURIComponent(issueId)}`}
              className="text-amber-400 hover:text-amber-300"
            >
              Casting
            </Link>
            <span className="ml-2 text-neutral-600">
              — voice sources &amp; clips (find-voice-sources pause)
            </span>
          </li>
          <li>
            <Link
              href="/admin/voices"
              className="text-violet-400 hover:text-violet-300"
            >
              Voice rotation
            </Link>
            <span className="ml-2 text-neutral-600">
              — global ElevenLabs / PVC tools
            </span>
          </li>
          <li>
            {issue.hasWebP ? (
              <Link
                href={`/book/${bookId}/${issueId}/review`}
                className="text-emerald-400 hover:text-emerald-300"
              >
                Bubble review (reader)
              </Link>
            ) : (
              <span className="text-neutral-600">Bubble review (reader)</span>
            )}
            <span className="ml-2 text-neutral-600">
              — karaoke-style text review
            </span>
            {!issue.hasWebP && (
              <span className="ml-2 text-neutral-500">
                (available after WebP publish)
              </span>
            )}
          </li>
        </ul>
      </div>
    </main>
  );
}
