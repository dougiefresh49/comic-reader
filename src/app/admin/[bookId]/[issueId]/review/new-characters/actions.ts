"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  clearNewCharactersPauseIfComplete,
  resumeCharacterReviewAndClearPause,
} from "~/server/admin/new-characters-resume";

/** Local copy of scripts/utils/registry.ts slugify. Do not import that module. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

export async function aliasNewCharacter(args: {
  bookId: string;
  issueId: string;
  /** Update bubbles whose speaker is any of these raw strings */
  speakerVariants: string[];
  canonicalName: string;
  scope: "global" | "book";
  /** Representative alias key (usually one of the variants) */
  aliasSource: string;
}) {
  const aliasKey = args.aliasSource.toLowerCase().trim();

  const { error: aErr } = await supabaseAdmin.from("aliases").upsert(
    {
      alias: aliasKey,
      canonical: args.canonicalName,
      scope: args.scope,
      scope_id: args.scope === "book" ? args.bookId : null,
    },
    { onConflict: "alias,scope,scope_id" },
  );
  if (aErr) return { ok: false as const, error: aErr.message };

  let updated = 0;
  for (const raw of args.speakerVariants) {
    const { data: rows, error: bErr } = await supabaseAdmin
      .from("bubbles")
      .update({
        speaker: args.canonicalName,
        needs_audio: true,
        updated_at: new Date().toISOString(),
      })
      .eq("book_id", args.bookId)
      .eq("issue_id", args.issueId)
      .eq("speaker", raw)
      .select("id");
    if (!bErr) updated += (rows ?? []).length;
  }

  await clearNewCharactersPauseIfComplete(args.bookId, args.issueId);

  revalidatePath(
    `/admin/${args.bookId}/${args.issueId}/review/new-characters`,
    "page",
  );
  revalidatePath(`/book/${args.bookId}/${args.issueId}/review`, "page");
  revalidatePath(`/book/${args.bookId}/${args.issueId}`, "page");

  return { ok: true as const, bubblesUpdated: updated };
}

export async function undoAliasNewCharacter(args: {
  bookId: string;
  issueId: string;
  originalName: string;
  canonicalName: string;
  scope: "global" | "book";
}) {
  let q = supabaseAdmin
    .from("aliases")
    .delete()
    .eq("alias", args.originalName.toLowerCase().trim())
    .eq("scope", args.scope);
  q =
    args.scope === "book"
      ? q.eq("scope_id", args.bookId)
      : q.is("scope_id", null);
  const { error: delErr } = await q;
  if (delErr) return { ok: false as const, error: delErr.message };

  const { error: bErr } = await supabaseAdmin
    .from("bubbles")
    .update({
      speaker: args.originalName,
      needs_audio: true,
      updated_at: new Date().toISOString(),
    })
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId)
    .eq("speaker", args.canonicalName);

  if (bErr) return { ok: false as const, error: bErr.message };

  revalidatePath(
    `/admin/${args.bookId}/${args.issueId}/review/new-characters`,
    "page",
  );
  revalidatePath(`/book/${args.bookId}/${args.issueId}`, "page");

  return { ok: true as const };
}

export async function keepAsNewCharacter(args: {
  bookId: string;
  issueId: string;
  resolvedName: string;
}) {
  const { data: bookRow, error: bookErr } = await supabaseAdmin
    .from("books")
    .select("franchises")
    .eq("id", args.bookId)
    .maybeSingle();
  if (bookErr) return { ok: false as const, error: bookErr.message };
  const franchises = (bookRow?.franchises as string[] | null) ?? [];
  const franchise = franchises[franchises.length - 1];
  if (!franchise) {
    return { ok: false as const, error: "no franchise on book" };
  }

  const id = slugify(args.resolvedName);
  if (!id) {
    return { ok: false as const, error: "name has no slugable characters" };
  }

  const { data, error } = await supabaseAdmin
    .from("characters")
    .upsert(
      {
        id,
        franchise,
        aliases: [args.resolvedName],
      },
      { onConflict: "id", ignoreDuplicates: true },
    )
    .select("id");
  if (error) return { ok: false as const, error: error.message };
  const inserted = (data?.length ?? 0) > 0;

  await clearNewCharactersPauseIfComplete(args.bookId, args.issueId);

  revalidatePath(
    `/admin/${args.bookId}/${args.issueId}/review/new-characters`,
    "page",
  );

  return { ok: true as const, inserted };
}

export async function unkeepAsNewCharacter(args: {
  bookId: string;
  issueId: string;
  resolvedName: string;
}) {
  const id = slugify(args.resolvedName);
  const { error } = await supabaseAdmin
    .from("characters")
    .delete()
    .eq("id", id);

  if (error) {
    if (error.code === "23503") {
      return { ok: false as const, error: "in use, can't undo" };
    }
    return { ok: false as const, error: error.message };
  }

  revalidatePath(
    `/admin/${args.bookId}/${args.issueId}/review/new-characters`,
    "page",
  );

  return { ok: true as const };
}

export async function approveAndContinuePipeline(args: {
  bookId: string;
  issueId: string;
}) {
  const res = await resumeCharacterReviewAndClearPause(
    args.bookId,
    args.issueId,
  );
  if (!res.ok) return { ok: false as const, error: res.error };
  return {
    ok: true as const,
    resumed: res.resumed,
    ...(res.resumeError ? { resumeError: res.resumeError } : {}),
  };
}
