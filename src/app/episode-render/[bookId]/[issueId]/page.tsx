import { notFound } from "next/navigation";
import { getManifest } from "~/server";
import { getPanelsForIssue } from "~/server/pages/panels";
import { pageImageUrl } from "~/lib/storage";
import { EpisodeRenderClient } from "./EpisodeRenderClient";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ bookId: string; issueId: string }>;
  searchParams: Promise<{ page?: string }>;
}

/**
 * Headless-renderable view of an issue.
 *
 * Drives the panel auto-play sequence end-to-end with no HUD, no
 * controls, no toolbar — just the page art + effects + audio. The
 * accompanying scripts/export-episode-mp4.ts uses Playwright to
 * navigate here, screen-record, and mux with audio.
 *
 * URL: /episode-render/<book>/<issue>?page=<n>
 *      Defaults to all pages if `page` is omitted.
 *
 * The route is hidden from the UI — there's no link to it from the
 * library — so it doesn't need auth.
 */
export default async function EpisodeRenderPage({
  params,
  searchParams,
}: Params) {
  const { bookId, issueId } = await params;
  const { page } = await searchParams;

  const manifest = await getManifest();
  const book = manifest.books.find((b) => b.id === bookId);
  const issue = book?.issues.find((i) => i.id === issueId);
  if (!book || !issue) notFound();

  const panels = await getPanelsForIssue(bookId, issueId);
  const onlyPage = page ? parseInt(page, 10) : null;
  const filteredPanels =
    onlyPage && Number.isFinite(onlyPage)
      ? panels.filter((p) => p.pageNumber === onlyPage)
      : panels;

  const pageImages: Record<number, string> = {};
  for (let n = 1; n <= issue.pageCount; n++) {
    pageImages[n] = pageImageUrl(bookId, issueId, n);
  }

  return (
    <main className="min-h-screen w-full bg-black">
      <EpisodeRenderClient
        bookId={bookId}
        issueId={issueId}
        panels={filteredPanels}
        pageImages={pageImages}
      />
    </main>
  );
}
