"use server";
// Page approval for the review editor: sets or clears `pages.reviewed_at` for one page of one issue.

import { headers } from "next/headers";
import { checkAdminAuth } from "~/lib/admin-auth";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { SPOKEN, needsSpeaker } from "~/components/review-editor/model";

export type ApprovalResult =
  | { ok: true; reviewedAt: string | null }
  | { ok: false; error: string; needSpeaker?: number };

/**
 * Approve a page (`approved` true) or take its approval back. Approving is
 * refused while a spoken bubble on the page, as saved, has no speaker and is
 * not marked silent (decisions row 228); the editor checks the same rule
 * before it calls, and saves the page's pending edits first.
 */
export async function setPageApproval(args: {
  bookId: string;
  issueId: string;
  page: number;
  approved: boolean;
}): Promise<ApprovalResult> {
  const auth = checkAdminAuth((await headers()).get("authorization"));
  if (!auth.ok) return { ok: false, error: auth.message };
  const { bookId, issueId, page, approved } = args;
  if (!bookId || !issueId || !Number.isInteger(page))
    return {
      ok: false,
      error: "A book, an issue and a page number are needed.",
    };

  if (approved) {
    const { data, error } = await supabaseAdmin
      .from("bubbles")
      .select("type, speaker, silent, ignored")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", page)
      .in("type", SPOKEN);
    if (error)
      return {
        ok: false,
        error: `Not approved: the page's bubbles could not be read (${error.message}).`,
      };
    const rows = (data ?? []) as {
      type: string;
      speaker: string | null;
      silent: boolean | null;
      ignored: boolean | null;
    }[];
    const missing = rows.filter((b) =>
      needsSpeaker({
        type: b.type,
        speaker: b.speaker,
        silent: b.silent ?? false,
        ignored: b.ignored ?? false,
      }),
    ).length;
    if (missing > 0)
      return {
        ok: false,
        needSpeaker: missing,
        error: `Not approved: ${missing} spoken ${missing === 1 ? "bubble" : "bubbles"} on page ${page} ${missing === 1 ? "has" : "have"} no speaker and ${missing === 1 ? "is" : "are"} not marked silent.`,
      };
  }

  const reviewedAt = approved ? new Date().toISOString() : null;
  const { data, error } = await supabaseAdmin
    .from("pages")
    .update({ reviewed_at: reviewedAt })
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("number", page)
    .select("number");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0)
    return {
      ok: false,
      error: `Page ${page} has no row in the pages table, so its approval cannot be stored.`,
    };
  return { ok: true, reviewedAt };
}
