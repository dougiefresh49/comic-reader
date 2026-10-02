// The v2 review editor's Save: every pending edit of one issue, written in one transaction or not at all.
// A route handler, not a server action: an action that revalidates re-renders the page it was called from,
// and the editor must keep its place after a Save.
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
  newPanelLabels,
  panelInsert,
  panelUpdate,
  saveRequestSchema,
  type SaveResult,
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
  try {
    const ctx = await loadWriteContext(bookId, issueId, {
      speakers: [
        ...bubbles.add.map((b) => b.speaker),
        ...bubbles.update.map((b) => b.set.speaker),
      ],
      boxBubbleIds: bubbles.update.filter((b) => b.set.box).map((b) => b.id),
    });
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
      ...bubbles.add.map(
        (b): Op => ({
          op: "insert",
          table: "bubbles",
          row: bubbleInsert(bookId, issueId, b, ctx),
        }),
      ),
      ...bubbles.update.map(
        (b): Op => ({
          op: "update",
          table: "bubbles",
          id: b.id,
          row: bubbleUpdate(b.id, b.page, b.set, ctx),
        }),
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
    return Response.json({ written: 0, needsAudio: 0 } satisfies SaveResult);
  }

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

  const pages = [
    ...bubbles.add,
    ...bubbles.update,
    ...bubbles.remove,
    ...panels.add,
    ...panels.update,
    ...panels.remove,
  ].map((r) => r.page);
  await revalidateReaderPages(bookId, issueId, pages);
  revalidatePath(`/admin/${bookId}/${issueId}/review/bubbles`, "page");
  revalidatePath(`/book/${bookId}`);
  revalidatePath("/");

  return Response.json({
    written: ops.length,
    needsAudio: ops.filter(
      (op) =>
        op.table === "bubbles" && op.op !== "delete" && op.row.needs_audio,
    ).length,
  } satisfies SaveResult);
}
