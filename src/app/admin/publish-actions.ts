"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { checkAdminAuth } from "~/lib/admin-auth";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { getManifest, getStoredPageCounts } from "~/server";

type Result = { ok: true } | { ok: false; error: string };

/**
 * Publishes or unpublishes one book, then drops the cached library, book
 * page and every reader page of that book so the change shows at once
 * rather than after the reader's day-long revalidate.
 */
export async function setBookPublished(
  bookId: string,
  published: boolean,
): Promise<Result> {
  const auth = checkAdminAuth((await headers()).get("authorization"));
  if (!auth.ok) return { ok: false, error: auth.message };
  if (!bookId) return { ok: false, error: "bookId is required" };

  const { data, error } = await supabaseAdmin
    .from("books")
    .update({ published })
    .eq("id", bookId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: `No book ${bookId}` };

  // No type argument: Next 15.2.6 tags a rendered page with its concrete
  // pathname, and a typed call only matches the route pattern's tags.
  revalidatePath("/");
  revalidatePath(`/book/${bookId}`);
  const book = (await getManifest()).books.find((b) => b.id === bookId);
  // The same count the reader uses, so an issue whose pages are uploaded but
  // not yet through the pipeline still has its cached reader pages dropped.
  const stored = await getStoredPageCounts();
  for (const issue of book?.issues ?? []) {
    const count = stored[bookId]?.[issue.id] ?? 0;
    const pageCount = issue.pageCount > 0 ? issue.pageCount : count;
    for (let n = 1; n <= pageCount; n++) {
      revalidatePath(`/book/${bookId}/${issue.id}/${n}`);
    }
  }
  revalidatePath("/admin");

  return { ok: true };
}
