import { randomUUID } from "node:crypto";
import { FatalError, getWorkflowMetadata } from "workflow";
import { boxFromStyle, scanBalloonPairs } from "~/lib/balloon-groups";
import { updateRunSteps } from "./pipeline-runs";

/**
 * A Postgres or PostgREST code is a data error a retry won't cure; no code
 * (a dropped connection) or PGRST0xx is transient, so the Workflow retries.
 */
function dbError(label: string, error: { message: string; code?: string }) {
  const message = `${label}: ${error.message}`;
  const transient = !error.code || error.code.startsWith("PGRST0");
  return transient ? new Error(message) : new FatalError(message);
}

/**
 * Joined balloons (#451): per page, run the finder (`scanBalloonPairs`) over
 * the voiced bubbles (ignored and silent ones skipped) and give each group it
 * finds that holds only rows with no `group_id` one fresh `group_id`. A row
 * that already carries one, shared or alone, is never regrouped, so an
 * editor join, split or "stands alone" survives a rerun.
 * Free: no model call. Each group's write also filters on `group_id is null`,
 * so a retry, or an editor Save landing meanwhile, never overwrites one.
 */
export async function groupBalloons(bookId: string, issueId: string) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  const { data: pages, error: pagesError } = await supabase
    .from("pages")
    .select("number, width, height")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .order("number");
  if (pagesError) throw dbError("pages", pagesError);

  let groups = 0;
  let members = 0;
  for (const page of pages ?? []) {
    const { data: rows, error } = await supabase
      .from("bubbles")
      .select(
        "id, panel_id, sort_order, character_id, type, ignored, silent, style, group_id",
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", page.number);
    if (error) throw dbError(`bubbles page ${page.number}`, error);

    // Every voiced row is scanned, grouped ones included, so neighbours stay
    // real neighbours: an ungrouped balloon never pairs across a group or a
    // "stands alone" balloon between it and the next. A found group that
    // holds an already-grouped row is dropped whole.
    const all = rows ?? [];
    const grouped = new Set(
      all.filter((b) => b.group_id !== null).map((b) => b.id),
    );
    const found = scanBalloonPairs(
      all
        .filter((b) => !b.silent)
        .map((b) => ({
          id: b.id,
          panelId: b.panel_id,
          sortOrder: b.sort_order,
          characterId: b.character_id,
          type: b.type,
          ignored: b.ignored,
          box: boxFromStyle(b.style, page.width, page.height),
        })),
    );
    for (const ids of found.groups) {
      if (ids.some((id) => grouped.has(id))) continue;
      const groupId = randomUUID();
      const { data: written, error: writeError } = await supabase
        .from("bubbles")
        .update({ group_id: groupId })
        .eq("book_id", bookId)
        .eq("issue_id", issueId)
        .in("id", ids)
        .is("group_id", null)
        .select("id");
      if (writeError) throw dbError(`group ${ids.join(",")}`, writeError);
      const n = written?.length ?? 0;
      if (n >= 2) {
        groups++;
        members += n;
        continue;
      }
      // Members took a group_id since the read. A lone survivor would read
      // as a "stands alone" mark nobody made, so it goes back to null.
      console.log(
        `[group-balloons] ${ids.join(",")}: ${n} of ${ids.length} written, not counted`,
      );
      if (n === 1) {
        const { error: undoError } = await supabase
          .from("bubbles")
          .update({ group_id: null })
          .eq("book_id", bookId)
          .eq("issue_id", issueId)
          .eq("group_id", groupId);
        if (undoError) throw dbError(`group ${groupId}`, undoError);
      }
    }
  }

  const pageCount = pages?.length ?? 0;
  console.log(
    `[group-balloons] ${bookId}/${issueId}: ${pageCount} pages scanned, ${groups} groups written, ${members} members`,
  );
  await updateRunSteps(
    supabase,
    bookId,
    issueId,
    getWorkflowMetadata().workflowRunId,
    (steps) => ({
      ...steps,
      groupBalloons: { pages: pageCount, groups, members },
    }),
    "group-balloons",
  );
  return { pages: pageCount, groups, members };
}
