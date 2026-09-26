import "server-only";
import { revalidatePath } from "next/cache";
import { resumeHook } from "workflow/api";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  analyzeNewCharacterQueue,
  type NewCharacterReview,
  type NewCharacterQueueResult,
} from "../../../scripts/utils/new-character-queue";

export type { NewCharacterReview, NewCharacterQueueResult };

function projectRoot(): string {
  return process.cwd();
}

export async function getNewCharacterReviews(
  bookId: string,
  issueId: string,
): Promise<NewCharacterQueueResult> {
  return analyzeNewCharacterQueue(supabaseAdmin, bookId, issueId, {
    projectRoot: projectRoot(),
  });
}

export async function getBookDisplayLabel(bookId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("books")
    .select("name")
    .eq("id", bookId)
    .maybeSingle();
  const row = data as { name: string } | null;
  return row?.name ?? bookId;
}

export async function getIssueDisplayLabel(
  bookId: string,
  issueId: string,
): Promise<string> {
  const { data } = await supabaseAdmin
    .from("issues")
    .select("name, number")
    .eq("book_id", bookId)
    .eq("id", issueId)
    .maybeSingle();
  const row = data as { name: string; number: number } | null;
  if (!row) return issueId;
  return row.name?.trim() ? row.name : `Issue ${row.number}`;
}

/** Resume the character-review hook and clear pause flags. */
export async function resumeCharacterReviewAndClearPause(
  bookId: string,
  issueId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = `ingest:${bookId}/${issueId}/character-review`;
  try {
    await resumeHook(token, { approved: true });
  } catch {
    // Hook missing or already resumed: still clear flags for the local CLI path.
  }

  const { error } = await supabaseAdmin
    .from("issues")
    .update({
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    })
    .eq("book_id", bookId)
    .eq("id", issueId);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/admin", "page");
  revalidatePath(`/admin/${bookId}/${issueId}/review/new-characters`, "page");

  return { ok: true };
}

/** Clears pipeline pause when no pending new-character reviews remain. */
export async function clearNewCharactersPauseIfComplete(
  bookId: string,
  issueId: string,
): Promise<void> {
  const { count } = await supabaseAdmin
    .from("issues")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId)
    .eq("id", issueId)
    .eq("pipeline_paused", true)
    .eq("pipeline_paused_at", "review-new-characters");

  if (!count) return;

  const { pendingCount } = await analyzeNewCharacterQueue(
    supabaseAdmin,
    bookId,
    issueId,
    { projectRoot: projectRoot() },
  );

  if (pendingCount > 0) return;

  await resumeCharacterReviewAndClearPause(bookId, issueId);
}
