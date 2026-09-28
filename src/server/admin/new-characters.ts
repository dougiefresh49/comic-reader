import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  analyzeNewCharacterQueue,
  type NewCharacterReview,
  type NewCharacterQueueResult,
} from "../../../scripts/utils/new-character-queue";
import { selectIssue } from "~/lib/issue-queries";

export type { NewCharacterReview, NewCharacterQueueResult };

function projectRoot(): string {
  return process.cwd();
}

/**
 * The page renders `error` in place of the queue, so a failed read never
 * looks like an empty queue and error.tsx never hides the message.
 */
export async function getNewCharacterReviews(
  bookId: string,
  issueId: string,
): Promise<NewCharacterQueueResult & { error: string | null }> {
  try {
    const result = await analyzeNewCharacterQueue(
      supabaseAdmin,
      bookId,
      issueId,
      { projectRoot: projectRoot() },
    );
    return { ...result, error: null };
  } catch (err) {
    return {
      autoResolved: [],
      queue: [],
      pendingCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
  const { data } = await selectIssue(
    supabaseAdmin,
    bookId,
    issueId,
    "name, number",
  ).maybeSingle();
  const row = data as { name: string; number: number } | null;
  if (!row) return issueId;
  return row.name?.trim() ? row.name : `Issue ${row.number}`;
}
