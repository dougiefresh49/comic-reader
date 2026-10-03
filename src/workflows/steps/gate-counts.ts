import type { SupabaseClient } from "@supabase/supabase-js";
import { FatalError } from "workflow";
import { analyzeNewCharacterQueue } from "../../../scripts/utils/new-character-queue";

/**
 * Pending new-character reviews for (book, issue). Calls
 * analyzeNewCharacterQueue without projectRoot (no filesystem reads).
 * A failed read throws from the helper, so it cannot look like an empty queue.
 * Rethrown as FatalError so the step fails on the first attempt, not after
 * the Workflow retries.
 */
export async function countPendingNewCharacters(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<number> {
  try {
    const { pendingCount } = await analyzeNewCharacterQueue(
      client,
      bookId,
      issueId,
    );
    return pendingCount;
  } catch (err) {
    throw new FatalError(err instanceof Error ? err.message : String(err));
  }
}
