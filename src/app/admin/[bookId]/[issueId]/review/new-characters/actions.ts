"use server";

import fs from "fs-extra";
import { dirname } from "path";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  clearNewCharactersPauseIfComplete,
  reviewedNewCharactersKeptPath,
} from "~/server/admin/new-characters";

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
  const path = reviewedNewCharactersKeptPath(args.bookId, args.issueId);
  await fs.ensureDir(dirname(path));
  let kept: string[] = [];
  if (await fs.pathExists(path)) {
    try {
      const data = (await fs.readJson(path)) as { kept?: string[] };
      kept = [...(data.kept ?? [])];
    } catch {
      kept = [];
    }
  }
  if (!kept.includes(args.resolvedName)) {
    kept.push(args.resolvedName);
    kept.sort();
  }
  await fs.writeJson(path, { kept }, { spaces: 2 });

  await clearNewCharactersPauseIfComplete(args.bookId, args.issueId);

  revalidatePath(
    `/admin/${args.bookId}/${args.issueId}/review/new-characters`,
    "page",
  );

  return { ok: true as const };
}

export async function unkeepAsNewCharacter(args: {
  bookId: string;
  issueId: string;
  resolvedName: string;
}) {
  const path = reviewedNewCharactersKeptPath(args.bookId, args.issueId);
  if (!(await fs.pathExists(path))) return { ok: true as const };
  let kept: string[] = [];
  try {
    const data = (await fs.readJson(path)) as { kept?: string[] };
    kept = (data.kept ?? []).filter((k) => k !== args.resolvedName);
  } catch {
    return { ok: true as const };
  }
  await fs.writeJson(path, { kept }, { spaces: 2 });

  revalidatePath(
    `/admin/${args.bookId}/${args.issueId}/review/new-characters`,
    "page",
  );

  return { ok: true as const };
}

export async function skipPipelinePause(args: {
  bookId: string;
  issueId: string;
}) {
  const { error } = await supabaseAdmin
    .from("issues")
    .update({
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    })
    .eq("book_id", args.bookId)
    .eq("id", args.issueId)
    .eq("pipeline_paused_at", "review-new-characters");

  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/admin", "page");
  revalidatePath(
    `/admin/${args.bookId}/${args.issueId}/review/new-characters`,
    "page",
  );

  return { ok: true as const };
}
