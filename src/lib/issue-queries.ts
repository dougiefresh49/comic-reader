/**
 * The only file allowed to call `.from("issues")` (eslint.config.js enforces it).
 *
 * `issues` has primary key `(book_id, id)` and every book has an `issue-1`, so
 * a query that filters `id` without `book_id` hits the wrong book's row. Each
 * function here takes the book as a required argument; callers chain
 * `.single()`, `.order()` and extra filters on the builder it returns.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "~/types/database";

// Accepts the repo's untyped clients too; queries below are typed against `Database`.
type Client = SupabaseClient;
const db = (client: Client) => client as SupabaseClient<Database>;
type IssueInsert = Database["public"]["Tables"]["issues"]["Insert"];
type IssueUpdate = Database["public"]["Tables"]["issues"]["Update"];

export function selectIssue<Q extends string>(
  client: Client,
  bookId: string,
  issueId: string,
  columns: Q,
) {
  return db(client)
    .from("issues")
    .select(columns)
    .eq("book_id", bookId)
    .eq("id", issueId);
}

/** Head-only count of one issue row; chain filters, then read `count`. */
export function countIssue(client: Client, bookId: string, issueId: string) {
  return db(client)
    .from("issues")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId)
    .eq("id", issueId);
}

export function updateIssue(
  client: Client,
  bookId: string,
  issueId: string,
  patch: IssueUpdate,
) {
  return db(client)
    .from("issues")
    .update(patch)
    .eq("book_id", bookId)
    .eq("id", issueId);
}

export function deleteIssue(client: Client, bookId: string, issueId: string) {
  return db(client)
    .from("issues")
    .delete()
    .eq("book_id", bookId)
    .eq("id", issueId);
}

/** The row carries `book_id` and `id`; the Insert type makes both required. */
export function insertIssue(client: Client, row: IssueInsert) {
  return db(client).from("issues").insert(row);
}

export function upsertIssue(client: Client, row: IssueInsert) {
  return db(client).from("issues").upsert(row, { onConflict: "book_id,id" });
}

export function listBookIssues<Q extends string>(
  client: Client,
  bookId: string,
  columns: Q,
) {
  return db(client).from("issues").select(columns).eq("book_id", bookId);
}

/** Every issue across books, for the admin index. */
export function listAllIssues<Q extends string>(client: Client, columns: Q) {
  return db(client).from("issues").select(columns);
}
