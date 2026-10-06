"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { checkAdminAuth } from "~/lib/admin-auth";
import { supabaseAdmin } from "~/lib/supabase-admin";

type Result = { ok: true } | { ok: false; error: string };

/**
 * Publishes or unpublishes one book, then revalidates the library, book pages
 * and reader pages. Only the library at `/` is cached today, for an hour, so
 * its call is the one that makes the change show at once. The book and reader
 * pages render on every request; their calls matter only if those pages are
 * cached later (#515).
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

  revalidatePath("/");
  // Typed invalidation matches the literal route pattern, including /01 URLs.
  revalidatePath("/book/[bookId]", "page");
  revalidatePath("/book/[bookId]/[issueId]/[pageNumber]", "page");
  revalidatePath("/admin");

  return { ok: true };
}
