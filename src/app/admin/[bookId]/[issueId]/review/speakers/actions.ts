"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";

interface ResolveArgs {
  reviewId: string;
  resolvedName: string;
  status: "accepted" | "renamed" | "skipped";
  saveAsAlias?: boolean;
  aliasScope?: "global" | "book";
}

export async function resolveSpeakerReview(args: ResolveArgs) {
  const { error } = await supabaseAdmin
    .from("speaker_reviews")
    .update({
      resolved_name: args.resolvedName,
      status: args.status,
      save_as_alias: args.saveAsAlias ?? false,
      alias_scope: args.aliasScope ?? null,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", args.reviewId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

interface UnresolveArgs {
  reviewId: string;
}

export async function unresolveSpeakerReview(args: UnresolveArgs) {
  const { error } = await supabaseAdmin
    .from("speaker_reviews")
    .update({
      resolved_name: null,
      status: "pending",
      save_as_alias: false,
      alias_scope: null,
      reviewed_at: null,
    })
    .eq("id", args.reviewId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function completeSpeakerReview(bookId: string, issueId: string) {
  // 1. Pull all reviewed rows for this issue
  const { data: reviews, error: rErr } = await supabaseAdmin
    .from("speaker_reviews")
    .select(
      "id, original_name, resolved_name, status, save_as_alias, alias_scope",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .neq("status", "pending");
  if (rErr) return { ok: false, error: rErr.message };

  type Review = {
    id: string;
    original_name: string;
    resolved_name: string | null;
    status: string;
    save_as_alias: boolean;
    alias_scope: string | null;
  };
  const reviewRows = (reviews ?? []) as Review[];

  // 2. For each rename, update bubbles where speaker = original_name → resolved_name
  let bubblesUpdated = 0;
  let aliasesAdded = 0;
  for (const r of reviewRows) {
    if (!r.resolved_name) continue;
    if (r.status === "renamed" && r.resolved_name !== r.original_name) {
      const { data: updatedRows, error: bErr } = await supabaseAdmin
        .from("bubbles")
        .update({
          speaker: r.resolved_name,
          needs_audio: true,
          updated_at: new Date().toISOString(),
        })
        .eq("book_id", bookId)
        .eq("issue_id", issueId)
        .eq("speaker", r.original_name)
        .select("id");
      if (!bErr) bubblesUpdated += (updatedRows ?? []).length;

      if (r.save_as_alias && r.alias_scope) {
        const { error: aErr } = await supabaseAdmin.from("aliases").upsert(
          {
            alias: r.original_name.toLowerCase().trim(),
            canonical: r.resolved_name,
            scope: r.alias_scope,
            scope_id: r.alias_scope === "book" ? bookId : null,
          },
          { onConflict: "alias,scope,scope_id" },
        );
        if (!aErr) aliasesAdded += 1;
      }
    }
  }

  // 3. Clear the issue's pause flag if it was paused on review-speakers
  await supabaseAdmin
    .from("issues")
    .update({
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    })
    .eq("book_id", bookId)
    .eq("id", issueId)
    .eq("pipeline_paused_at", "review-speakers");

  // 4. Invalidate caches
  revalidatePath(`/book/${bookId}/${issueId}`, "page");
  revalidatePath(`/book/${bookId}/${issueId}/review`, "page");
  revalidatePath(`/admin/${bookId}/${issueId}/review/speakers`, "page");
  revalidatePath("/admin", "page");

  return {
    ok: true,
    bubblesUpdated,
    aliasesAdded,
    reviewCount: reviewRows.length,
  };
}
