import "server-only";
import { supabase } from "~/lib/supabase";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { listAllIssues } from "~/lib/issue-queries";

export interface AdminIssueRow {
  bookId: string;
  bookName: string;
  issueId: string;
  issueName: string;
  number: number;
  partId: string | null;
  partName: string | null;
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
}

interface IssueQueryRow {
  id: string;
  book_id: string;
  number: number;
  name: string;
  part_id: string | null;
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
  book_parts: { id: string; name: string; number: number } | null;
}

/**
 * `steps.runId` of each issue's newest `pipeline_runs` row by `started_at`, any
 * status, keyed `${bookId}/${issueId}`. A row from before runIds were recorded
 * gives null. Pass one issue to read just its row.
 * SQL: select book_id, issue_id, steps->>'runId' from pipeline_runs
 *      [where book_id = $1 and issue_id = $2]
 *      order by started_at desc nulls last [limit 1]
 */
export async function getLatestRunIds(issue?: {
  bookId: string;
  issueId: string;
}): Promise<Map<string, string | null>> {
  let query = supabaseAdmin
    .from("pipeline_runs")
    .select("book_id, issue_id, runId:steps->>runId")
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
    }> | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("getLatestRunIds:", error);
    throw new Error(`getLatestRunIds: ${error.message}`, { cause: error });
  }

  const map = new Map<string, string | null>();
  for (const row of data ?? []) {
    const key = `${row.book_id}/${row.issue_id}`;
    if (!map.has(key)) map.set(key, row.runId ?? null);
  }
  return map;
}

export async function getAdminIssues(): Promise<AdminIssueRow[]> {
  // Run ids first: trigger-ingest writes the issue row before it inserts the
  // run row, so an issue read after this one never predates the run id it sees.
  const latestRunIds = await getLatestRunIds();
  const { data, error } = await listAllIssues(
    supabase,
    "id, book_id, number, name, part_id, page_count, bubble_count, audio_count, has_webp, has_audio, has_timestamps, status, pipeline_step, pipeline_paused, pipeline_paused_at, pipeline_paused_url, books(id, name), book_parts(id, name, number)",
  )
    .order("book_id")
    .order("number");

  if (error) {
    console.error("getAdminIssues:", error);
    throw new Error(`getAdminIssues: ${error.message}`, { cause: error });
  }

  return ((data ?? []) as unknown as IssueQueryRow[]).map((row) => ({
    bookId: row.book_id,
    bookName: row.books?.name ?? row.book_id,
    issueId: row.id,
    issueName: row.name,
    number: row.number,
    partId: row.part_id,
    partName: row.book_parts?.name ?? null,
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
    latestRunId: latestRunIds.get(`${row.book_id}/${row.id}`) ?? null,
  }));
}

export interface AdminBookInfo {
  id: string;
  name: string;
  totalIssues: number | null;
  publisher: string | null;
  /** `franchises.name` through `book_franchises`, lowest `position` first. */
  franchises: string[];
  parts: {
    id: string;
    name: string;
    number: number;
    totalIssues: number | null;
  }[];
}

export async function getAdminBooksWithParts(): Promise<AdminBookInfo[]> {
  const { data, error } = await supabase
    .from("books")
    .select(
      "id, name, total_issues, publisher, book_franchises(position, franchises(name)), book_parts(id, name, number, total_issues)",
    )
    .order("name");

  if (error) {
    console.error("getAdminBooksWithParts:", error);
    throw new Error(`getAdminBooksWithParts: ${error.message}`, {
      cause: error,
    });
  }

  return (
    (data ?? []) as unknown as Array<{
      id: string;
      name: string;
      total_issues: number | null;
      publisher: string | null;
      book_franchises:
        | { position: number; franchises: { name: string } | null }[]
        | null;
      book_parts:
        | {
            id: string;
            name: string;
            number: number;
            total_issues: number | null;
          }[]
        | null;
    }>
  ).map((b) => ({
    id: b.id,
    name: b.name,
    totalIssues: b.total_issues,
    publisher: b.publisher,
    franchises: [...(b.book_franchises ?? [])]
      .sort((a, z) => a.position - z.position)
      .flatMap((f) => (f.franchises ? [f.franchises.name] : [])),
    parts: (b.book_parts ?? [])
      .sort((a, z) => a.number - z.number)
      .map((p) => ({
        id: p.id,
        name: p.name,
        number: p.number,
        totalIssues: p.total_issues,
      })),
  }));
}
