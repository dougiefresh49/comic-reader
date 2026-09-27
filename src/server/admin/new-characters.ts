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
