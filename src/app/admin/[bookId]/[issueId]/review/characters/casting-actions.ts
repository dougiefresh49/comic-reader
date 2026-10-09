"use server";

/**
 * The casting page's calls into the casting moves engine (#786). Staging
 * happens on the client; these three read the account, review the staged
 * moves, and run them.
 *
 * Spends only in `confirmMoves`, on the owner's Confirm: ElevenLabs adds for
 * restores and designs, DELETEs for archives, and the free GETs and Storage
 * uploads of the backups. `loadRoster` and `reviewMoves` read only.
 */
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  accountRoster,
  planMoves,
  runMoves,
  type Move,
  type MovesPlan,
  type Roster,
  type RunResult,
} from "~/lib/casting-moves";
import { requireAdmin } from "~/server/admin/require-admin";

interface Scope {
  bookId: string;
  issueId: string;
}

export type CastingResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function fail(what: string, err: unknown): { ok: false; error: string } {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`casting moves, ${what}:`, err);
  return { ok: false, error: message };
}

const deps = () => ({ supabase: supabaseAdmin });

/** The account's slots: who holds each and whether it can move (`accountRoster`). */
export async function loadRoster(): Promise<CastingResult<Roster>> {
  try {
    await requireAdmin();
    return { ok: true, data: await accountRoster(deps()) };
  } catch (err) {
    return fail("loading the roster", err);
  }
}

/** The staged moves in run order, with slots, credits, headroom and blockers (`planMoves`). Reads only. */
export async function reviewMoves(args: {
  scope: Scope;
  moves: Move[];
}): Promise<CastingResult<MovesPlan>> {
  try {
    await requireAdmin();
    const { bookId, issueId } = args.scope;
    return {
      ok: true,
      data: await planMoves(deps(), bookId, issueId, args.moves),
    };
  } catch (err) {
    return fail("reviewing moves", err);
  }
}

/** Runs the staged moves (`runMoves`): refuses with the blockers when the plan has any, else spends. */
export async function confirmMoves(args: {
  scope: Scope;
  moves: Move[];
}): Promise<CastingResult<RunResult>> {
  const { bookId, issueId } = args.scope;
  try {
    await requireAdmin();
    return {
      ok: true,
      data: await runMoves(deps(), bookId, issueId, args.moves),
    };
  } catch (err) {
    return fail("confirming moves", err);
  } finally {
    revalidatePath(`/admin/${bookId}/${issueId}/review/characters`, "page");
  }
}
