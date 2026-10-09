"use server";

import { fetchWikiCoverUrl, wikiPageTitle } from "~/lib/add-content/wiki";
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
