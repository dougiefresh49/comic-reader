import "server-only";
import { supabase } from "~/lib/supabase";

export interface PipelineReviewIssue {
  issueId: string;
  bookId: string;
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
  const { data, error } = await supabase
    .from("issues")
    .select(
      "id, book_id, number, name, page_count, has_webp, status, pipeline_step, pipeline_paused, pipeline_paused_at, pipeline_paused_url",
    )
    .eq("book_id", bookId)
    .eq("id", issueId)
    .maybeSingle();

  if (error) {
    console.error("getPipelineReviewIssue:", error);
    return null;
  }
  if (!data) return null;

  const row = data as {
    id: string;
    book_id: string;
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
