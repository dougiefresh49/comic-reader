import "server-only";
import { supabase } from "~/lib/supabase";

export interface AdminIssueRow {
  bookId: string;
  bookName: string;
  issueId: string;
  issueName: string;
  number: number;
  pageCount: number;
  bubbleCount: number;
  audioCount: number;
  hasWebP: boolean;
  hasAudio: boolean;
  hasTimestamps: boolean;
  status: string;
  pipelineStep: string | null;
  pipelinePaused: boolean;
  pipelinePausedAt: string | null;
  pipelinePausedUrl: string | null;
}

interface IssueQueryRow {
  id: string;
  book_id: string;
  number: number;
  name: string;
  page_count: number;
  bubble_count: number;
  audio_count: number;
  has_webp: boolean;
  has_audio: boolean;
  has_timestamps: boolean;
  status: string;
  pipeline_step: string | null;
  pipeline_paused: boolean;
  pipeline_paused_at: string | null;
  pipeline_paused_url: string | null;
  books: { id: string; name: string } | null;
}

export async function getAdminIssues(): Promise<AdminIssueRow[]> {
  const { data, error } = await supabase
    .from("issues")
    .select(
      "id, book_id, number, name, page_count, bubble_count, audio_count, has_webp, has_audio, has_timestamps, status, pipeline_step, pipeline_paused, pipeline_paused_at, pipeline_paused_url, books(id, name)",
    )
    .order("book_id")
    .order("number");

  if (error) {
    console.error("getAdminIssues:", error);
    return [];
  }

  return ((data ?? []) as unknown as IssueQueryRow[]).map((row) => ({
    bookId: row.book_id,
    bookName: row.books?.name ?? row.book_id,
    issueId: row.id,
    issueName: row.name,
    number: row.number,
    pageCount: row.page_count,
    bubbleCount: row.bubble_count,
    audioCount: row.audio_count,
    hasWebP: row.has_webp,
    hasAudio: row.has_audio,
    hasTimestamps: row.has_timestamps,
    status: row.status,
    pipelineStep: row.pipeline_step,
    pipelinePaused: row.pipeline_paused,
    pipelinePausedAt: row.pipeline_paused_at,
    pipelinePausedUrl: row.pipeline_paused_url,
  }));
}

export interface AdminBookRow {
  id: string;
  name: string;
  slug: string | null;
  seriesId: string | null;
  issueCount: number;
}

export async function getAdminBooks(): Promise<AdminBookRow[]> {
  const { data, error } = await supabase
    .from("books")
    .select("id, name, slug, series_id, issues(id)")
    .order("name");

  if (error) {
    console.error("getAdminBooks:", error);
    return [];
  }

  return (
    (data ?? []) as unknown as Array<{
      id: string;
      name: string;
      slug: string | null;
      series_id: string | null;
      issues: Array<{ id: string }> | null;
    }>
  ).map((b) => ({
    id: b.id,
    name: b.name,
    slug: b.slug,
    seriesId: b.series_id,
    issueCount: (b.issues ?? []).length,
  }));
}
