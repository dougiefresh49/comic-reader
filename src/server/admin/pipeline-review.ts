import "server-only";
import { supabase } from "~/lib/supabase";
import { selectIssue } from "~/lib/issue-queries";

export interface PipelineReviewIssue {
  issueId: string;
  bookId: string;
  bookName: string;
  number: number;
  name: string;
  pageCount: number;
  hasWebP: boolean;
  status: string;
  pipelineStep: string | null;
  pipelinePaused: boolean;
  pipelinePausedAt: string | null;
  pipelinePausedUrl: string | null;
}

export async function getPipelineReviewIssue(
  bookId: string,
  issueId: string,
): Promise<PipelineReviewIssue | null> {
  const { data, error } = await selectIssue(
    supabase,
    bookId,
    issueId,
    "id, book_id, number, name, page_count, has_webp, status, pipeline_step, pipeline_paused, pipeline_paused_at, pipeline_paused_url, books(name)",
  ).maybeSingle();

  if (error) {
    throw new Error(`getPipelineReviewIssue: ${error.message}`, {
      cause: error,
    });
  }
  if (!data) return null;

  const row = data as unknown as {
    id: string;
    book_id: string;
    books: { name: string } | null;
    number: number;
    name: string;
    page_count: number;
    has_webp: boolean;
    status: string;
    pipeline_step: string | null;
    pipeline_paused: boolean;
    pipeline_paused_at: string | null;
    pipeline_paused_url: string | null;
  };

  return {
    issueId: row.id,
    bookId: row.book_id,
    bookName: row.books?.name ?? row.book_id,
    number: row.number,
    name: row.name,
    pageCount: row.page_count,
    hasWebP: row.has_webp,
    status: row.status,
    pipelineStep: row.pipeline_step,
    pipelinePaused: row.pipeline_paused,
    pipelinePausedAt: row.pipeline_paused_at,
    pipelinePausedUrl: row.pipeline_paused_url,
  };
}
