"use server";
// Page approval for the review editor: sets or clears `pages.reviewed_at` for one page, and checks an issue is ready to leave the pages gate.

import { headers } from "next/headers";
import { checkAdminAuth } from "~/lib/admin-auth";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  type ReadyResult,
  bubbleWord,
  canResumePages,
  unvoicedByPage,
} from "~/server/admin/pages-gate";

export type { ReadyResult };

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
    const unvoiced = await unvoicedByPage(bookId, issueId, page);
    if (!unvoiced.ok)
      return {
        ok: false,
        error: `Not approved: the page's bubbles could not be read (${unvoiced.error}).`,
      };
    const missing = unvoiced.counts.get(page) ?? 0;
    if (missing > 0)
      return {
        ok: false,
        needSpeaker: missing,
        error: `Not approved: ${bubbleWord(missing)} on page ${page} ${missing === 1 ? "has" : "have"} no speaker and ${missing === 1 ? "is" : "are"} not marked silent.`,
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

/**
 * Before Approve issue resumes the run: the pages gate's check
 * (`canResumePages`), which the resume route also runs for `page-review`.
 */
export async function checkIssueReady(args: {
  bookId: string;
  issueId: string;
}): Promise<ReadyResult> {
  const auth = checkAdminAuth((await headers()).get("authorization"));
  if (!auth.ok) return { ok: false, error: auth.message };
  const { bookId, issueId } = args;
  if (!bookId || !issueId)
    return { ok: false, error: "A book and an issue are needed." };
  return canResumePages(bookId, issueId);
}
