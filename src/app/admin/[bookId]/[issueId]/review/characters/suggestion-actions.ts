"use server";

/**
 * Dismiss and Restore for a wiki name in the characters stop's Needs a name
 * section (#751). The only write is `issues.dismissed_wiki_names`, a list of
 * slugs for this issue: never a character, alias or cast row.
 */
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { selectIssue, updateIssue } from "~/lib/issue-queries";
import { slugify } from "~/lib/character-id";
import { requireAdmin } from "~/server/admin/require-admin";
import type { ActionResult } from "./actions";

interface Scope {
  bookId: string;
  issueId: string;
}

function revalidate({ bookId, issueId }: Scope) {
  revalidatePath(`/admin/${bookId}/${issueId}/review/characters`, "page");
}

function fail(what: string, err: unknown): { ok: false; error: string } {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`characters stop, ${what}:`, err);
  return { ok: false, error: message };
}

/** Rewrites the issue's dismissed slugs with `change` applied. */
async function editDismissed(
  scope: Scope,
  name: string,
  change: (slugs: string[], slug: string) => string[],
): Promise<void> {
  const slug = slugify(name.trim());
  if (!slug) throw new Error("a name is needed");
  const read = await selectIssue(
    supabaseAdmin,
    scope.bookId,
    scope.issueId,
    "dismissed_wiki_names",
  ).maybeSingle();
  if (read.error) throw new Error(`reading the issue: ${read.error.message}`);
  if (!read.data) throw new Error(`no issue ${scope.bookId}/${scope.issueId}`);
  const slugs = read.data.dismissed_wiki_names;
  const { error } = await updateIssue(
    supabaseAdmin,
    scope.bookId,
    scope.issueId,
    { dismissed_wiki_names: change(slugs, slug) },
  );
  if (error) throw new Error(`saving the issue: ${error.message}`);
  revalidate(scope);
}

export async function dismissWikiName(args: {
  scope: Scope;
  name: string;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    await editDismissed(args.scope, args.name, (slugs, slug) =>
      slugs.includes(slug) ? slugs : [...slugs, slug],
    );
    return { ok: true, message: `${args.name} is dismissed for this issue.` };
  } catch (err) {
    return fail("dismissing a wiki name", err);
  }
}

export async function restoreWikiName(args: {
  scope: Scope;
  name: string;
}): Promise<ActionResult> {
  try {
    await requireAdmin();
    await editDismissed(args.scope, args.name, (slugs, slug) =>
      slugs.filter((s) => s !== slug),
    );
    return { ok: true, message: `${args.name} is back in Needs a name.` };
  } catch (err) {
    return fail("restoring a wiki name", err);
  }
}
