import "server-only";
import { join } from "path";
import { revalidatePath } from "next/cache";
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

/** Path to persisted "kept as new" acknowledgements (relative uses cwd). */
export function reviewedNewCharactersKeptPath(
  bookId: string,
  issueId: string,
): string {
  return join(
    projectRoot(),
    "assets",
    "comics",
    bookId,
    issueId,
    "data",
    "reviewed-new-characters-kept.json",
  );
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

  await supabaseAdmin
    .from("issues")
    .update({
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    })
    .eq("book_id", bookId)
    .eq("id", issueId);

  revalidatePath("/admin", "page");
}
