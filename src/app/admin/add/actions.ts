"use server";

import { fetchWikiCoverUrl, wikiPageTitle } from "~/lib/add-content/wiki";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { requireAdmin } from "~/server/admin/require-admin";

/**
 * The wiki cover of one issue, for a book that is not saved yet (#793). A
 * read of the wiki's API: no writes, no paid call. Null when there is none.
 */
export async function wikiCover(args: {
  wikiHost: string;
  wikiTitleTemplate: string;
  issueNumber: number;
}): Promise<string | null> {
  await requireAdmin();
  return fetchWikiCoverUrl(
    args.wikiHost,
    wikiPageTitle(args.wikiTitleTemplate, args.issueNumber),
  );
}

/**
 * Whether a `books` row exists. After `createBook` reports an error, the row
 * may still be there (its franchise links failed after the insert).
 */
export async function bookExists(id: string): Promise<boolean> {
  await requireAdmin();
  const { data, error } = await supabaseAdmin
    .from("books")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data !== null;
}
