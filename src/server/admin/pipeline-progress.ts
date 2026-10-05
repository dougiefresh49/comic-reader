import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";

/**
 * Read side of the issue hub (#334): the latest `pipeline_runs` row and the
 * row counts the hub turns into progress. Reads only; every query filters by
 * book and issue. Each count's SQL is in the comment beside it so a verifier
 * can rerun it.
 */

/** One timing window as `recordStepStart` writes it on `steps.timings`. */
export interface StepWindow {
  startedAt: string;
  endedAt?: string;
  pages?: number;
}

export interface GateSkip {
  gate: string;
  reason: string;
  at: string;
}

export interface GateWait {
  gate: string;
  waitedAt: string;
  releasedAt?: string;
}

export interface PipelineRun {
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  fromStep: string | null;
  timings: Record<string, StepWindow[]>;
  skipped: GateSkip[];
  gateWaits: GateWait[];
  /** No writer records one today; read in case a later run does. */
  error: string | null;
  /** Why the masks step failed. Masks run after the issue is ready, so this is the only record of it (#356). */
  masksError: string | null;
}

export interface ProgressCounts {
  pages: number;
  panels: number;
  pagesWithPanels: number;
  panelsWithMasks: number;
  bubbles: number;
  bubblesWithSpeaker: number;
  /** Bubbles with a speaker that are not ignored: the ones audio is made for. */
  spokenBubbles: number;
  bubblesWithAudio: number;
  /** Face detections on this issue's panels plus face exemplars from it. */
  faces: number;
  facesNamed: number;
  castingTasks: number;
  castingTasksDone: number;
  castlist: number;
  castlistWithVoice: number;
}

export interface PipelineProgress {
  run: PipelineRun | null;
  counts: ProgressCounts;
}

type RawSteps = {
  fromStep?: string | null;
  timings?: Record<string, StepWindow[]>;
  skipped?: GateSkip[];
  gateWaits?: GateWait[];
  error?: string;
  masksError?: string;
};

/**
 * Latest run for the issue, by `started_at`.
 * SQL: select * from pipeline_runs where book_id = $1 and issue_id = $2
 *      order by started_at desc nulls last limit 1
 */
async function getLatestRun(
  bookId: string,
  issueId: string,
): Promise<PipelineRun | null> {
  const { data, error } = (await supabaseAdmin
    .from("pipeline_runs")
    .select("status, started_at, completed_at, steps")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()) as {
    data: {
      status: string;
      started_at: string | null;
      completed_at: string | null;
      steps: RawSteps | null;
    } | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("getLatestRun:", error);
    return null;
  }
  if (!data) return null;

  const steps = data.steps ?? {};
  return {
    status: data.status,
    startedAt: data.started_at,
    completedAt: data.completed_at,
    fromStep: steps.fromStep ?? null,
    timings:
      steps.timings && typeof steps.timings === "object" ? steps.timings : {},
    skipped: Array.isArray(steps.skipped) ? steps.skipped : [],
    gateWaits: Array.isArray(steps.gateWaits) ? steps.gateWaits : [],
    error: typeof steps.error === "string" ? steps.error : null,
    masksError: typeof steps.masksError === "string" ? steps.masksError : null,
  };
}

type CountResult = { count: number | null; error: { message: string } | null };

/** A head count that logs and reads 0 on error, so one bad table never blanks the hub. */
function countOf(label: string, result: CountResult): number {
  if (result.error) {
    console.error(`pipeline-progress ${label}:`, result.error.message);
    return 0;
  }
  return result.count ?? 0;
}

async function getCounts(
  bookId: string,
  issueId: string,
): Promise<ProgressCounts> {
  const scoped = (table: string) =>
    supabaseAdmin
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId);

  // Panels come back as rows, not a count, because three numbers fall out of
  // one read: the count, the distinct page numbers, and the ids the face
  // detection counts need.
  // SQL: select id, page_number, foreground_polygons is not null as masked
  //      from panels where book_id = $1 and issue_id = $2
  const panelsQuery = supabaseAdmin
    .from("panels")
    .select("id, page_number, foreground_polygons")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  const [
    panelsResult,
    pages,
    bubbles,
    bubblesWithSpeaker,
    spokenBubbles,
    bubblesWithAudio,
    exemplars,
    exemplarsNamed,
    castingTasks,
    castingTasksDone,
    castlist,
    castlistWithVoice,
  ] = await Promise.all([
    panelsQuery,
    // select count(*) from pages where book_id = $1 and issue_id = $2
    scoped("pages"),
    // select count(*) from bubbles where book_id = $1 and issue_id = $2
    scoped("bubbles"),
    // ... and speaker is not null
    scoped("bubbles").not("speaker", "is", null),
    // ... and speaker is not null and ignored = false
    scoped("bubbles").not("speaker", "is", null).eq("ignored", false),
    // ... and speaker is not null and ignored = false and audio_storage_path is not null
    // (the same filters as spokenBubbles, so the ratio can never exceed 1)
    scoped("bubbles")
      .not("speaker", "is", null)
      .eq("ignored", false)
      .not("audio_storage_path", "is", null),
    // select count(*) from character_face_exemplars
    //   where book_id = $1 and source_issue = $2
    supabaseAdmin
      .from("character_face_exemplars")
      .select("*", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("source_issue", issueId),
    // ... and character_id is not null
    supabaseAdmin
      .from("character_face_exemplars")
      .select("*", { count: "exact", head: true })
      .eq("book_id", bookId)
      .eq("source_issue", issueId)
      .not("character_id", "is", null),
    // select count(*) from casting_tasks where book_id = $1 and issue_id = $2
    scoped("casting_tasks"),
    // ... and completed_at is not null
    scoped("casting_tasks").not("completed_at", "is", null),
    // select count(*) from castlist where book_id = $1 and issue_id = $2
    scoped("castlist"),
    // ... and voice_id is not null
    scoped("castlist").not("voice_id", "is", null),
  ]);

  const panelRows = (panelsResult.error ? [] : (panelsResult.data ?? [])) as {
    id: string;
    page_number: number;
    foreground_polygons: unknown;
  }[];
  if (panelsResult.error) {
    console.error("pipeline-progress panels:", panelsResult.error.message);
  }
  const panelIds = panelRows.map((p) => p.id);

  // Detections hang off panels, so they are scoped through this issue's panel ids.
  // SQL: select count(*) from panel_character_detections d
  //      join panels p on p.id = d.panel_id
  //      where p.book_id = $1 and p.issue_id = $2 [and d.character_id is not null]
  let detections = 0;
  let detectionsNamed = 0;
  if (panelIds.length > 0) {
    const [all, named] = await Promise.all([
      supabaseAdmin
        .from("panel_character_detections")
        .select("*", { count: "exact", head: true })
        .in("panel_id", panelIds),
      supabaseAdmin
        .from("panel_character_detections")
        .select("*", { count: "exact", head: true })
        .in("panel_id", panelIds)
        .not("character_id", "is", null),
    ]);
    detections = countOf("detections", all);
    detectionsNamed = countOf("detectionsNamed", named);
  }

  return {
    pages: countOf("pages", pages),
    panels: panelRows.length,
    pagesWithPanels: new Set(panelRows.map((p) => p.page_number)).size,
    panelsWithMasks: panelRows.filter((p) => p.foreground_polygons !== null)
      .length,
    bubbles: countOf("bubbles", bubbles),
    bubblesWithSpeaker: countOf("bubblesWithSpeaker", bubblesWithSpeaker),
    spokenBubbles: countOf("spokenBubbles", spokenBubbles),
    bubblesWithAudio: countOf("bubblesWithAudio", bubblesWithAudio),
    faces: detections + countOf("exemplars", exemplars),
    facesNamed: detectionsNamed + countOf("exemplarsNamed", exemplarsNamed),
    castingTasks: countOf("castingTasks", castingTasks),
    castingTasksDone: countOf("castingTasksDone", castingTasksDone),
    castlist: countOf("castlist", castlist),
    castlistWithVoice: countOf("castlistWithVoice", castlistWithVoice),
  };
}

export async function getPipelineProgress(
  bookId: string,
  issueId: string,
): Promise<PipelineProgress> {
  const [run, counts] = await Promise.all([
    getLatestRun(bookId, issueId),
    getCounts(bookId, issueId),
  ]);
  return { run, counts };
}
