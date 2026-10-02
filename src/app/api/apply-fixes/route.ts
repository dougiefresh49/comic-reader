import "server-only";
import { revalidatePath } from "next/cache";
import { type NextRequest } from "next/server";
import { adminAuthFailure, checkAdminAuth } from "~/lib/admin-auth";
import { revalidateReaderPages } from "~/lib/revalidate-reader";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  bubbleInsert,
  bubbleUpdate,
  loadWriteContext,
  type BubbleEdit,
  type WriteContext,
} from "./write-rules";

interface FixBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FixChanges {
  speaker?: string | null;
  emotion?: string;
  ocr_text?: string;
  type?: string;
  textWithCues?: string;
  ignored?: boolean;
  bounds?: FixBounds;
}

type FixEntry =
  | { bubbleId: string; action: "update"; changes: FixChanges }
  | { bubbleId: string; action: "delete" }
  | {
      bubbleId: string;
      action: "add";
      pageIndex: number;
      data: FixChanges & {
        ocr_text?: string;
        speaker?: string | null;
        emotion?: string;
        type?: string;
        textWithCues?: string;
        panelId?: string | null;
      };
    }
  | {
      bubbleId: "__page-reorder__";
      action: "reorder";
      pageIndex: number;
      orderedIds: string[];
    };

interface FixesJson {
  bookId: string;
  issueId: string;
  fixes: FixEntry[];
}

/** The old editor's change, in the shared rules' terms (write-rules.ts). */
function toEdit(changes: FixChanges): BubbleEdit {
  const { bounds } = changes;
  return {
    speaker: changes.speaker,
    text: changes.ocr_text,
    textWithCues: changes.textWithCues,
    type: changes.type,
    emotion: changes.emotion,
    ignored: changes.ignored,
    box: bounds
      ? { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }
      : undefined,
  };
}

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}

async function resolveBubbleUuid(
  bookId: string,
  issueId: string,
  bubbleId: string,
): Promise<string | null> {
  if (isUuid(bubbleId)) return bubbleId;
  const { data, error } = await supabaseAdmin
    .from("bubbles")
    .select("id")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("legacy_id", bubbleId)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { id: string }).id;
}

function pageNumFromIndex(idx: number): number {
  return idx;
}

/**
 * Every added bubble must name a panel on its own page, unless that page has
 * no panels. Runs before any write, since a 200 makes the editor drop its
 * local edits and a refused bubble would vanish with them.
 */
async function findPanelProblems(
  bookId: string,
  issueId: string,
  fixes: FixEntry[],
): Promise<string[]> {
  const panelIdsByPage = new Map<number, Set<string>>();
  const problems: string[] = [];
  for (const fix of fixes) {
    if (fix.action !== "add") continue;
    const pageNum = pageNumFromIndex(fix.pageIndex);
    let panelIds = panelIdsByPage.get(pageNum);
    if (!panelIds) {
      const { data, error } = await supabaseAdmin
        .from("panels")
        .select("id")
        .eq("book_id", bookId)
        .eq("issue_id", issueId)
        .eq("page_number", pageNum);
      if (error) {
        problems.push(`add:${fix.bubbleId} (panels read: ${error.message})`);
        continue;
      }
      panelIds = new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
      panelIdsByPage.set(pageNum, panelIds);
    }
    const { panelId } = fix.data;
    if (panelId) {
      if (!panelIds.has(panelId)) {
        problems.push(
          `add:${fix.bubbleId} (panel ${panelId} is not on page ${pageNum})`,
        );
      }
    } else if (panelIds.size > 0) {
      problems.push(`add:${fix.bubbleId} (no panel picked on page ${pageNum})`);
    }
  }
  return problems;
}

export async function POST(req: NextRequest) {
  const auth = checkAdminAuth(req.headers.get("authorization"));
  if (!auth.ok) return adminAuthFailure(auth);

  let payload: FixesJson;
  try {
    payload = (await req.json()) as FixesJson;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { bookId, issueId, fixes } = payload;
  if (!bookId || !issueId || !Array.isArray(fixes)) {
    return Response.json({ error: "Invalid fixes payload" }, { status: 400 });
  }

  const panelProblems = await findPanelProblems(bookId, issueId, fixes);
  if (panelProblems.length > 0) {
    return Response.json(
      { error: "Added bubble panel check failed", skipped: panelProblems },
      { status: 400 },
    );
  }

  // What the shared rules read first: page sizes and the stored confidence
  // for box edits, and which speakers are `characters` rows.
  const boxIds: string[] = [];
  for (const fix of fixes) {
    if (fix.action !== "update" || !fix.changes.bounds) continue;
    const uuid = await resolveBubbleUuid(bookId, issueId, fix.bubbleId);
    if (uuid) boxIds.push(uuid);
  }
  let ctx: WriteContext;
  try {
    ctx = await loadWriteContext(bookId, issueId, {
      speakers: fixes.flatMap((f) =>
        f.action === "update"
          ? [f.changes.speaker]
          : f.action === "add"
            ? [f.data.speaker]
            : [],
      ),
      boxBubbleIds: boxIds,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }

  const results = {
    applied: 0,
    skipped: [] as string[],
    needsAudio: 0,
  };

  const audioAffectedUuids = new Set<string>();

  for (const fix of fixes) {
    try {
      if (fix.action === "delete") {
        const uuid = await resolveBubbleUuid(bookId, issueId, fix.bubbleId);
        if (!uuid) {
          results.skipped.push(`delete:${fix.bubbleId} (not found)`);
          continue;
        }
        const { error } = await supabaseAdmin
          .from("bubbles")
          .delete()
          .eq("id", uuid)
          .eq("book_id", bookId)
          .eq("issue_id", issueId);
        if (error) {
          results.skipped.push(`delete:${fix.bubbleId} (${error.message})`);
        } else {
          results.applied += 1;
        }
        continue;
      }

      if (fix.action === "update") {
        const uuid = await resolveBubbleUuid(bookId, issueId, fix.bubbleId);
        if (!uuid) {
          results.skipped.push(`update:${fix.bubbleId} (not found)`);
          continue;
        }
        const page = ctx.bubblePage.get(uuid);
        if (fix.changes.bounds && page === undefined) {
          results.skipped.push(`update:${fix.bubbleId} (not found)`);
          continue;
        }
        const patch = bubbleUpdate(uuid, page ?? 0, toEdit(fix.changes), ctx);
        if (patch.needs_audio) audioAffectedUuids.add(uuid);

        const { error } = await supabaseAdmin
          .from("bubbles")
          .update(patch)
          .eq("id", uuid)
          .eq("book_id", bookId)
          .eq("issue_id", issueId);
        if (error) {
          results.skipped.push(`update:${fix.bubbleId} (${error.message})`);
        } else {
          results.applied += 1;
        }
        continue;
      }

      if (fix.action === "add") {
        const pageNum = pageNumFromIndex(fix.pageIndex);
        const { data: existing } = await supabaseAdmin
          .from("bubbles")
          .select("sort_order")
          .eq("book_id", bookId)
          .eq("issue_id", issueId)
          .eq("page_number", pageNum)
          .order("sort_order", { ascending: false })
          .limit(1)
          .maybeSingle();
        const nextSort =
          ((existing as { sort_order?: number } | null)?.sort_order ?? -1) + 1;

        const insertRow = bubbleInsert(
          bookId,
          issueId,
          {
            ...toEdit(fix.data),
            panelId: fix.data.panelId ?? null,
            page: pageNum,
            sortOrder: nextSort,
            legacyId: fix.bubbleId,
          },
          ctx,
        );
        const { data: ins, error } = await supabaseAdmin
          .from("bubbles")
          .insert(insertRow)
          .select("id")
          .single();
        if (error) {
          results.skipped.push(`add:${fix.bubbleId} (${error.message})`);
        } else {
          results.applied += 1;
          const id = (ins as { id?: string } | null)?.id;
          if (id) audioAffectedUuids.add(id);
        }
        continue;
      }

      if (fix.action === "reorder") {
        for (let i = 0; i < fix.orderedIds.length; i++) {
          const id = fix.orderedIds[i]!;
          const uuid = await resolveBubbleUuid(bookId, issueId, id);
          if (!uuid) {
            results.skipped.push(`reorder:${id} (not found)`);
            continue;
          }
          const { error } = await supabaseAdmin
            .from("bubbles")
            .update({ sort_order: i })
            .eq("id", uuid)
            .eq("book_id", bookId)
            .eq("issue_id", issueId);
          if (error) {
            results.skipped.push(`reorder:${id} (${error.message})`);
          } else {
            results.applied += 1;
          }
        }
        continue;
      }
    } catch (e) {
      results.skipped.push(
        `${fix.action}:${"bubbleId" in fix ? fix.bubbleId : "?"} (${(e as Error).message})`,
      );
    }
  }

  results.needsAudio = audioAffectedUuids.size;

  // Invalidate ISR cache
  await revalidateReaderPages(bookId, issueId);
  revalidatePath(`/admin/${bookId}/${issueId}/review/bubbles`, "page");
  revalidatePath(`/book/${bookId}`);
  revalidatePath("/");

  return Response.json(results);
}
