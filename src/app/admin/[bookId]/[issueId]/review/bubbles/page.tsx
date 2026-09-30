import { notFound } from "next/navigation";
import { getManifest, getIssueData } from "~/server";
import { getPanelsForIssue } from "~/server/pages/panels";
import { sortPanelsForReading } from "~/lib/panel-reading-order";
import { ReviewLayout } from "~/components/review/ReviewLayout";
import type { ReviewPanel } from "~/components/review/PanelPicker";
import type { PageDirectedPanel } from "~/types/panels";

export const dynamic = "force-dynamic";

interface ReviewPageProps {
  params: Promise<{
    bookId: string;
    issueId: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReviewPage({
  params,
  searchParams,
}: ReviewPageProps) {
  const { bookId, issueId } = await params;
  const sp = await searchParams;

  const manifest = await getManifest();

  const book = manifest.books.find((b) => b.id === bookId);
  if (!book) notFound();

  const issue = book.issues.find((i) => i.id === issueId);
  if (!issue) notFound();

  const rawPage = typeof sp.page === "string" ? parseInt(sp.page, 10) : 1;
  const initialPage = isNaN(rawPage)
    ? 1
    : Math.max(1, Math.min(rawPage, issue.pageCount));

  const [{ allBubbles, characters }, panels] = await Promise.all([
    getIssueData(bookId, issueId),
    getPanelsForIssue(bookId, issueId),
  ]);
  const mode = typeof sp.mode === "string" ? sp.mode : undefined;

  const panelsOnPage = new Map<number, PageDirectedPanel[]>();
  for (const p of panels) {
    panelsOnPage.set(p.pageNumber, [
      ...(panelsOnPage.get(p.pageNumber) ?? []),
      p,
    ]);
  }
  const panelsByPage: Record<number, ReviewPanel[]> = {};
  for (const [pageNumber, pagePanels] of panelsOnPage) {
    panelsByPage[pageNumber] = sortPanelsForReading(pagePanels).map(
      ({ id, boundingBox }) => ({ id, boundingBox }),
    );
  }

  return (
    <ReviewLayout
      bookId={bookId}
      issueId={issueId}
      issueData={issue}
      allBubbles={allBubbles}
      panelsByPage={panelsByPage}
      characters={characters}
      initialPage={initialPage}
      mode={mode}
    />
  );
}
