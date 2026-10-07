// The v2 review editor's Save: every pending edit of one issue, written in one transaction or not at all.
// A route handler, not a server action: an action that revalidates re-renders the page it was called from,
// and the editor must keep its place after a Save.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { type NextRequest } from "next/server";
import { adminAuthFailure, checkAdminAuth } from "~/lib/admin-auth";
import {
  decodeRawImage,
  pixelBoxOf,
  sampleFillColorRaw,
} from "~/lib/bubble-fill";
import { revalidateReaderPages } from "~/lib/revalidate-reader";
import { pageStoragePath } from "~/lib/storage";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { CANDIDATE_TYPES } from "~/lib/word-geometry-assign";
import { wordGeometryForPage } from "~/lib/word-geometry-page";
import type { Database } from "~/types/database";
import {
  bubbleInsert,
  bubbleUpdate,
  boxRowsByPage,
  loadWriteContext,
  newPanelLabels,
  panelInsert,
  panelUpdate,
  saveRequestSchema,
  type SaveResult,
  type WriteContext,
} from "../write-rules";

type Op =
  | {
      op: "insert";
      table: "bubbles" | "panels";
      row: Record<string, unknown>;
    }
  | {
      op: "update";
      table: "bubbles" | "panels";
      id: string;
      row: Record<string, unknown>;
    }
  | { op: "delete"; table: "bubbles" | "panels"; id: string };

function fail(error: string, status: number) {
  return Response.json({ error }, { status });
}

/**
 * Sets `fill_color` on each box-writing bubble row from its page image, one
 * download per page (#575). An updated row skips its stored `text_geometry`
 * word boxes, read in one query (#597); an inserted row has none. A failed
 * geometry read logs a warning and samples unmasked. A page that fails to
 * download or decode logs a warning and writes null on its rows; the Save
 * still goes through.
 */
async function setFillColors(
  bookId: string,
  issueId: string,
  byPage: Map<number, Record<string, unknown>[]>,
  updateIds: Map<Record<string, unknown>, string>,
) {
  const ids = [...byPage.values()]
    .flat()
    .flatMap((row) => updateIds.get(row) ?? []);
  const geometry = new Map<string, unknown>();
  if (ids.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("bubbles")
      .select("id, text_geometry")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .in("id", ids);
    if (error)
      console.warn(
        `[save] word boxes not read, fill colours sampled unmasked (${error.message})`,
      );
    for (const b of (data ?? []) as { id: string; text_geometry: unknown }[])
      geometry.set(b.id, b.text_geometry);
  }

  await Promise.all(
    Array.from(byPage, async ([page, rows]) => {
      try {
        const { data, error } = await supabaseAdmin.storage
          .from("comic-pages")
          .download(pageStoragePath(bookId, issueId, page));
        if (error || !data) throw new Error(error?.message ?? "no image");
        const image = await decodeRawImage(
          new Uint8Array(await data.arrayBuffer()),
        );
        for (const row of rows) {
          const box = pixelBoxOf(row.box_2d);
          const id = updateIds.get(row);
          row.fill_color = box
            ? sampleFillColorRaw(
                image,
                box,
                id === undefined ? null : geometry.get(id),
              )
            : null;
        }
      } catch (e) {
        console.warn(
          `[save] page ${page}: no fill colour sampled, writing null (${(e as Error).message})`,
        );
        for (const row of rows) row.fill_color = null;
      }
    }),
  );
}

/**
 * The pages whose word boxes this Save makes stale (#620). A bubble's
 * `text_geometry` is assigned from the lines its box covered when the page was
 * OCR'd, and its `fill_color` is sampled with those word boxes skipped. A box
 * that moves or grows keeps the old boxes, so the reader's highlight lands on
 * the old lettering; a bubble drawn new has none, so the reader falls back to
 * the caption highlight. So a page re-runs its word boxes when this Save writes
 * the box of a row that is a word-geometry candidate after the Save
 * (`whereWordGeometryCandidate`): a candidate type, not ignored, with a style.
 * Each field comes from the row being written, else as stored; a box row always
 * writes `style`, and an insert row carries all three.
 */
function wordBoxPages(
  boxRows: Map<number, Record<string, unknown>[]>,
  updateIds: Map<Record<string, unknown>, string>,
  ctx: WriteContext,
): number[] {
  const candidateTypes: readonly string[] = CANDIDATE_TYPES;
  return Array.from(boxRows)
    .filter(([, rows]) =>
      rows.some((row) => {
        const id = updateIds.get(row);
        const type =
          "type" in row
            ? row.type
            : id === undefined
              ? undefined
              : ctx.type.get(id);
        const ignored =
          "ignored" in row
            ? row.ignored
            : id !== undefined && ctx.ignored.has(id);
        return (
          typeof type === "string" &&
          candidateTypes.includes(type) &&
          ignored === false &&
          row.style != null
        );
      }),
    )
    .map(([page]) => page)
    .sort((a, b) => a - b);
}

export async function POST(req: NextRequest) {
  const auth = checkAdminAuth(req.headers.get("authorization"));
  if (!auth.ok) return adminAuthFailure(auth);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Nothing was saved: the request was not JSON.", 400);
  }
  const parsed = saveRequestSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(
      `Nothing was saved: the request is malformed (${first?.path.join(".") ?? "?"}: ${first?.message ?? "invalid"}).`,
      400,
    );
  }
  const { bookId, issueId, bubbles, panels } = parsed.data;

  let ctx: WriteContext;
  try {
    ctx = await loadWriteContext(bookId, issueId, {
      speakers: [
        ...bubbles.add.map((b) => b.speaker),
        ...bubbles.update.map((b) => b.set.speaker),
      ],
      bubbleIds: [...bubbles.update, ...bubbles.remove].map((b) => b.id),
    });
  } catch (e) {
    return fail(`Nothing was saved: ${(e as Error).message}`, 500);
  }
  // An existing bubble is on the page its row says, whatever the request
  // says. One the read did not find is left to save_review_edits, which
  // fails the whole Save on it.
  for (const b of [...bubbles.update, ...bubbles.remove]) {
    const stored = ctx.bubblePage.get(b.id);
    if (stored !== undefined && stored !== b.page)
      return fail(
        `Nothing was saved: bubble ${b.id} is on page ${stored}, not page ${b.page}.`,
        400,
      );
  }

  // Every panel a bubble names must be one of this issue's panels on the
  // bubble's own page, after this Save's adds and removals.
  const { data: panelRows, error: panelError } = await supabaseAdmin
    .from("panels")
    .select("id, page_number, panel_id")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);
  if (panelError)
    return fail(
      `Nothing was saved: could not read the panels (${panelError.message}).`,
      500,
    );
  const existingPanels = (panelRows ?? []) as {
    id: string;
    page_number: number;
    panel_id: string;
  }[];
  const panelPage = new Map(existingPanels.map((p) => [p.id, p.page_number]));
  for (const p of panels.remove) panelPage.delete(p.id);
  for (const p of panels.add) panelPage.set(p.id, p.page);
  const named = [
    ...bubbles.add.map((b) => ({ id: b.id, page: b.page, panelId: b.panelId })),
    ...bubbles.update.map((b) => ({
      id: b.id,
      page: b.page,
      panelId: b.set.panelId,
    })),
  ];
  for (const b of named) {
    if (b.panelId && panelPage.get(b.panelId) !== b.page) {
      return fail(
        `Nothing was saved: bubble ${b.id} names panel ${b.panelId}, which is not on page ${b.page} of this issue.`,
        400,
      );
    }
  }

  let ops: Op[];
  let boxRows: Map<number, Record<string, unknown>[]>;
  try {
    const addRows = bubbles.add.map((b) => ({
      page: b.page,
      row: bubbleInsert(bookId, issueId, b, ctx),
    }));
    const updateRows = bubbles.update.map((b) => ({
      id: b.id,
      page: b.page,
      row: bubbleUpdate(b.id, b.page, b.set, ctx),
    }));
    boxRows = boxRowsByPage([...addRows, ...updateRows]);
    const labels = newPanelLabels(
      existingPanels.map((p) => p.panel_id),
      panels.add.map((p) => p.page),
    );
    // Panels go in before the bubbles that name them, and out after the
    // bubbles that left them.
    ops = [
      ...panels.add.map(
        (p, i): Op => ({
          op: "insert",
          table: "panels",
          row: panelInsert(bookId, issueId, p, labels[i] ?? ""),
        }),
      ),
      ...panels.update.map(
        (p): Op => ({
          op: "update",
          table: "panels",
          id: p.id,
          row: panelUpdate(p),
        }),
      ),
      ...addRows.map(
        ({ row }): Op => ({ op: "insert", table: "bubbles", row }),
      ),
      ...updateRows.map(
        ({ id, row }): Op => ({ op: "update", table: "bubbles", id, row }),
      ),
      ...bubbles.remove.map(
        (b): Op => ({ op: "delete", table: "bubbles", id: b.id }),
      ),
      ...panels.remove.map(
        (p): Op => ({ op: "delete", table: "panels", id: p.id }),
      ),
    ].filter((op) => op.op !== "update" || Object.keys(op.row).length > 0);
  } catch (e) {
    return fail(`Nothing was saved: ${(e as Error).message}`, 500);
  }

  if (ops.length === 0) {
    return Response.json({
      written: 0,
      needsAudio: 0,
      wordBoxesFailed: [],
    } satisfies SaveResult);
  }

  // The rows are shared with `ops`, so this lands in the RPC payload. An
  // update row carries no id, so its op names it.
  const updateIds = new Map(
    ops.flatMap((op) =>
      op.op === "update" && op.table === "bubbles"
        ? [[op.row, op.id] as const]
        : [],
    ),
  );
  await setFillColors(bookId, issueId, boxRows, updateIds);

  const { error, status } = await supabaseAdmin.rpc("save_review_edits", {
    p_book_id: bookId,
    p_issue_id: issueId,
    p_ops: ops,
  });
  if (error) {
    // A coded answer below 500 means the transaction rolled back. With no
    // code, status 0 or a 5xx, it may still have committed.
    const unconfirmed = !error.code || status === 0 || status >= 500;
    return unconfirmed
      ? fail(
          `The save may or may not have landed (${error.message}). Your edits are still here; reload the editor to see the rows as they are now.`,
          502,
        )
      : fail(`Nothing was saved: ${error.message}`, 409);
  }

  // The rows are committed; a page whose word boxes fail to refresh is
  // reported in the answer and never fails the Save.
  const refreshPages = wordBoxPages(boxRows, updateIds, ctx);
  const refreshed = await Promise.allSettled(
    refreshPages.map((page) =>
      wordGeometryForPage(
        // supabaseAdmin is untyped; the bubbles schema is the generated one.
        supabaseAdmin as SupabaseClient<Database>,
        bookId,
        issueId,
        page,
      ),
    ),
  );
  const wordBoxesFailed: SaveResult["wordBoxesFailed"] = [];
  refreshPages.forEach((page, i) => {
    const r = refreshed[i];
    if (r?.status !== "rejected") return;
    const error =
      r.reason instanceof Error ? r.reason.message : String(r.reason);
    console.warn(`[save] page ${page}: word boxes not refreshed (${error})`);
    wordBoxesFailed.push({ page, error });
  });

  const pages = [
    ...bubbles.add,
    ...bubbles.update,
    ...bubbles.remove,
    ...panels.add,
    ...panels.update,
    ...panels.remove,
  ].map((r) => r.page);
  await revalidateReaderPages(bookId, issueId, pages);
  revalidatePath(`/admin/${bookId}/${issueId}/review/editor`, "page");
  revalidatePath(`/book/${bookId}`);
  revalidatePath("/");

  return Response.json({
    written: ops.length,
    needsAudio: ops.filter(
      (op) =>
        op.table === "bubbles" && op.op !== "delete" && op.row.needs_audio,
    ).length,
    wordBoxesFailed,
  } satisfies SaveResult);
}
