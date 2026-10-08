import "server-only";
import { supabase } from "~/lib/supabase";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { listAllIssues } from "~/lib/issue-queries";
import type { GateWait } from "~/server/admin/pipeline-progress";

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
  /** `steps.runId` of the issue's newest `pipeline_runs` row, any status. */
  latestRunId: string | null;
  /**
   * `waitedAt` of the newest gate wait with no `releasedAt` on that same row,
   * or null. A new value means the run paused again after a Resume.
   */
  openGateWaitAt: string | null;
}

export interface LatestRun {
  runId: string | null;
  openGateWaitAt: string | null;
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

/**
 * `steps.runId` and the open gate wait's `waitedAt` of each issue's newest
 * `pipeline_runs` row by `started_at`, any status, keyed `${bookId}/${issueId}`.
 * A row from before runIds were recorded gives a null runId. Pass one issue to
 * read just its row.
 * SQL: select book_id, issue_id, steps->>'runId', steps->'gateWaits'
 *      from pipeline_runs [where book_id = $1 and issue_id = $2]
 *      order by started_at desc nulls last [limit 1]
 */
export async function getLatestRunIds(issue?: {
  bookId: string;
  issueId: string;
}): Promise<Map<string, LatestRun>> {
  let query = supabaseAdmin
    .from("pipeline_runs")
    .select(
      "book_id, issue_id, runId:steps->>runId, gateWaits:steps->gateWaits",
    )
    .order("started_at", { ascending: false, nullsFirst: false });
  if (issue) {
    query = query
      .eq("book_id", issue.bookId)
      .eq("issue_id", issue.issueId)
      .limit(1);
  }
  const { data, error } = (await query) as {
    data: Array<{
      book_id: string;
      issue_id: string;
      runId: string | null;
      gateWaits: unknown;
    }> | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("getLatestRunIds:", error);
    throw new Error(`getLatestRunIds: ${error.message}`, { cause: error });
  }

  const map = new Map<string, LatestRun>();
  for (const row of data ?? []) {
    const key = `${row.book_id}/${row.issue_id}`;
    if (map.has(key)) continue;
    map.set(key, {
      runId: row.runId ?? null,
      openGateWaitAt: newestOpenWait(row.gateWaits),
    });
  }
  return map;
}

function newestOpenWait(gateWaits: unknown): string | null {
  if (!Array.isArray(gateWaits)) return null;
  let newest: string | null = null;
  for (const w of gateWaits as (Partial<GateWait> | null)[]) {
    if (!w || w.releasedAt !== undefined || typeof w.waitedAt !== "string") {
      continue;
    }
    if (newest === null || w.waitedAt > newest) newest = w.waitedAt;
  }
  return newest;
}

export async function getAdminIssues(): Promise<AdminIssueRow[]> {
  // Run rows first: trigger-ingest writes the issue row before it inserts the
  // run row, so an issue read after this one never predates the run id it sees.
  const latestRuns = await getLatestRunIds();
  const { data, error } = await listAllIssues(
    supabase,
    "id, book_id, number, name, page_count, bubble_count, audio_count, has_webp, has_audio, has_timestamps, status, pipeline_step, pipeline_paused, pipeline_paused_at, pipeline_paused_url, books(id, name)",
  )
    .order("book_id")
    .order("number");

  if (error) {
    console.error("getAdminIssues:", error);
    throw new Error(`getAdminIssues: ${error.message}`, { cause: error });
  }

  return ((data ?? []) as unknown as IssueQueryRow[]).map((row) => {
    const latestRun = latestRuns.get(`${row.book_id}/${row.id}`);
    return {
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
      latestRunId: latestRun?.runId ?? null,
      openGateWaitAt: latestRun?.openGateWaitAt ?? null,
    };
  });
}

export interface AdminBookInfo {
  id: string;
  name: string;
  totalIssues: number | null;
  publisher: string | null;
  /** `franchises.name` through `book_franchises`, lowest `position` first. */
  franchises: string[];
  /** The series this book is a volume of, or null for a standalone book. */
  series: { name: string; position: number | null } | null;
}

export async function getAdminBooks(): Promise<AdminBookInfo[]> {
  const { data, error } = await supabase
    .from("books")
    .select(
      "id, name, total_issues, publisher, series_position, book_franchises(position, franchises(name)), series(id, name)",
    )
    .order("name");

  if (error) {
    console.error("getAdminBooks:", error);
    throw new Error(`getAdminBooks: ${error.message}`, {
      cause: error,
    });
  }

  return (
    (data ?? []) as unknown as Array<{
      id: string;
      name: string;
      total_issues: number | null;
      publisher: string | null;
      series_position: number | null;
      book_franchises:
        | { position: number; franchises: { name: string } | null }[]
        | null;
      series: { id: string; name: string } | null;
    }>
  ).map((b) => ({
    id: b.id,
    name: b.name,
    totalIssues: b.total_issues,
    publisher: b.publisher,
    franchises: [...(b.book_franchises ?? [])]
      .sort((a, z) => a.position - z.position)
      .flatMap((f) => (f.franchises ? [f.franchises.name] : [])),
    series: b.series
      ? { name: b.series.name, position: b.series_position }
      : null,
  }));
}
