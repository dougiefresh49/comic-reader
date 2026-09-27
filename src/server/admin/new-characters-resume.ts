import "server-only";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { analyzeNewCharacterQueue } from "../../../scripts/utils/new-character-queue";
import { countIssue, updateIssue } from "~/lib/issue-queries";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "~/types/database";

function projectRoot(): string {
  return process.cwd();
}

function isHookNotFoundMessage(message: string): boolean {
  return /not found|already resumed|no hook/i.test(message);
}

async function isHookNotFound(err: unknown): Promise<boolean> {
  try {
    const { HookNotFoundError } = await import(
      /* webpackIgnore: true */
      /* turbopackIgnore: true */
      "workflow/errors"
    );
    if (
      HookNotFoundError &&
      typeof HookNotFoundError.is === "function" &&
      HookNotFoundError.is(err)
    ) {
      return true;
    }
  } catch {
    // workflow/errors unavailable (local dev) or no HookNotFoundError export.
  }
  const msg = err instanceof Error ? err.message : String(err);
  return isHookNotFoundMessage(msg);
}

/** Resume the character-review hook and clear pause flags. */
export async function resumeCharacterReviewAndClearPause(
  bookId: string,
  issueId: string,
): Promise<
  | { ok: true; resumed: boolean; resumeError?: string }
  | { ok: false; error: string }
> {
  const token = `ingest:${bookId}/${issueId}/character-review`;
  let resumed = false;
  let resumeError: string | undefined;

  try {
    const { resumeHook } = await import(
      /* webpackIgnore: true */
      /* turbopackIgnore: true */
      "workflow/api"
    );
    try {
      await resumeHook(token, { approved: true });
      resumed = true;
    } catch (err) {
      // Hook missing or already resumed: still clear flags for the local CLI path.
      // Any other resumeHook error: leave flags alone and surface the error.
      if (!(await isHookNotFound(err))) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  } catch (err) {
    // Dev bundle can't load workflow/api; treat as no live run, surface the text.
    resumeError = err instanceof Error ? err.message : String(err);
  }

  const { error } = await updateIssue(
    supabaseAdmin as SupabaseClient<Database>,
    bookId,
    issueId,
    {
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    },
  ).eq("pipeline_paused_at", "review-new-characters");

  if (error) return { ok: false, error: error.message };

  revalidatePath("/admin", "page");
  revalidatePath(`/admin/${bookId}/${issueId}/review/new-characters`, "page");

  return resumeError
    ? { ok: true, resumed, resumeError }
    : { ok: true, resumed };
}

/** Clears pipeline pause when no pending new-character reviews remain. */
export async function clearNewCharactersPauseIfComplete(
  bookId: string,
  issueId: string,
): Promise<void> {
  const { count } = await countIssue(
    supabaseAdmin as SupabaseClient<Database>,
    bookId,
    issueId,
  )
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
