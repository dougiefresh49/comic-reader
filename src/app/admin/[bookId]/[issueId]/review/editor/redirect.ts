// The retired review pages (review/bubbles, review/speakers, /book/<book>/<issue>/review) send the owner to the review editor.
import "server-only";
import { redirect } from "next/navigation";

interface OldReviewProps {
  params: Promise<{ bookId: string; issueId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Redirect to the review editor, keeping `?page=` when the old link had one. */
export async function redirectToEditor({
  params,
  searchParams,
}: OldReviewProps): Promise<never> {
  const { bookId, issueId } = await params;
  const { page } = await searchParams;
  const n = typeof page === "string" ? parseInt(page, 10) : NaN;
  redirect(
    `/admin/${bookId}/${issueId}/review/editor${Number.isNaN(n) ? "" : `?page=${n}`}`,
  );
}
