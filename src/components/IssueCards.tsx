import Link from "next/link";
import { pageImageUrl } from "~/lib/storage";
import { OfflineDownload } from "~/components/OfflineDownload";
import { CoverImage } from "~/components/ui/CoverImage";
import type { IssueManifest } from "~/types/manifest";

/** "Issue 3" / "issue-3" → "#3"; falls back to a short monogram. */
function issueMonogram(issue: IssueManifest): string {
  const num = /\d+/.exec(issue.name) ?? /\d+/.exec(issue.id);
  return num ? `#${num[0]}` : issue.name.slice(0, 2).toUpperCase();
}

/**
 * One book's issues as the book page shows them: the empty-state line, or a
 * grid of cards. Shared by `/book/<bookId>` and `/series/<seriesId>`, which
 * also share `MetaChip` (below) for the chips under their hero titles; the
 * hero rows themselves stay in each page.
 */
export function IssueGrid({
  bookId,
  bookName,
  issues,
  offlineUrlsByIssue,
}: {
  bookId: string;
  bookName: string;
  issues: IssueManifest[];
  offlineUrlsByIssue: Record<string, string[]>;
}) {
  return issues.length === 0 ? (
    <p className="text-sm text-neutral-400">No issues available.</p>
  ) : (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {issues.map((issue) =>
        issue.hasWebP ? (
          <AvailableIssueCard
            key={issue.id}
            bookId={bookId}
            bookName={bookName}
            issue={issue}
            offlineUrls={offlineUrlsByIssue[issue.id] ?? []}
          />
        ) : (
          <ComingSoonIssueCard key={issue.id} bookId={bookId} issue={issue} />
        ),
      )}
    </div>
  );
}

export function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-300">
      {children}
    </span>
  );
}

function AvailableIssueCard({
  bookId,
  bookName,
  issue,
  offlineUrls,
}: {
  bookId: string;
  bookName: string;
  issue: IssueManifest;
  offlineUrls: string[];
}) {
  const readHref = `/book/${bookId}/${issue.id}/1`;

  return (
    <div className="flex flex-col rounded-2xl border border-white/10 bg-white/5 p-3 transition-colors hover:bg-white/10">
      <Link
        href={readHref}
        className="group rounded-xl focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:outline-none"
        aria-label={`Read ${bookName} ${issue.name}`}
      >
        <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-neutral-900">
          <CoverImage
            src={pageImageUrl(bookId, issue.id, 1)}
            alt={`${bookName} - ${issue.name}`}
            fallbackLabel={issueMonogram(issue)}
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, (max-width: 1280px) 20vw, 16vw"
            className="transition-transform duration-300 group-hover:scale-[1.02]"
          />
        </div>
      </Link>

      <div className="mt-3 px-1">
        <h3 className="text-sm font-semibold text-neutral-100">{issue.name}</h3>
        <div className="mt-1 flex items-center gap-2 text-xs text-neutral-500">
          <span className="tabular-nums">{issue.pageCount} pages</span>
          {issue.hasAudio ? <AudioBadge /> : null}
        </div>
      </div>

      {/* Fixed footer slot so card heights align across the row */}
      <div className="mt-auto flex min-h-[4.75rem] flex-col justify-end gap-2 pt-3">
        <Link
          href={readHref}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-cyan-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:outline-none"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="none"
            aria-hidden
          >
            <polygon points="6,4 20,12 6,20" />
          </svg>
          Read
        </Link>
        {offlineUrls.length > 0 ? (
          <OfflineDownload
            urls={offlineUrls}
            label={`${bookName} ${issue.name}`}
          />
        ) : null}
      </div>
    </div>
  );
}

function ComingSoonIssueCard({
  bookId,
  issue,
}: {
  bookId: string;
  issue: IssueManifest;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-3">
      {/* Real cover when one exists in storage (dimmed); monogram otherwise */}
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-neutral-900 opacity-60">
        <CoverImage
          src={pageImageUrl(bookId, issue.id, 1)}
          alt={`${issue.name} — coming soon`}
          fallbackLabel={issueMonogram(issue)}
          fallbackCaption={null}
          sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, (max-width: 1280px) 20vw, 16vw"
        />
      </div>

      <div className="mt-3 px-1">
        <h3 className="text-sm font-semibold text-neutral-400">{issue.name}</h3>
        <p className="mt-1 text-xs text-neutral-600 tabular-nums">
          {issue.pageCount > 0 ? `${issue.pageCount} pages` : "Not yet added"}
        </p>
      </div>

      {/* Same footer slot height as available cards */}
      <div className="mt-auto flex min-h-[4.75rem] items-end justify-center pt-3 pb-1">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-neutral-400">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          Coming soon
        </span>
      </div>
    </div>
  );
}

function AudioBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
        <path d="M16 9a5 5 0 0 1 0 6" />
        <path d="M19.364 18.364a9 9 0 0 0 0-12.728" />
      </svg>
      Audio
    </span>
  );
}
