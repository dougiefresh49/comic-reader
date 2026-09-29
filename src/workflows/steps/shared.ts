import type { SupabaseClient } from "@supabase/supabase-js";
import { FatalError } from "workflow";
import { pageStoragePath } from "~/lib/storage";
import { updateIssue } from "~/lib/issue-queries";

export interface PageMeta {
  pageNumber: number;
  width: number;
  height: number;
}

export type BoundingBoxJson = { x: number; y: number; w: number; h: number };

/**
 * Plain (non-step) page list: `pages` rows plus one Storage list check.
 * Returns [] only when there are no rows. Throws FatalError naming every
 * page whose WebP is missing from the bucket. Safe for plain `tsx` scripts.
 */
export async function queryPageList(
  supabase: SupabaseClient,
  bookId: string,
  issueId: string,
): Promise<PageMeta[]> {
  const { data: rows, error } = await supabase
    .from("pages")
    .select("number, width, height")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .order("number");

  if (error) {
    throw new Error(
      `pages query failed for ${bookId}/${issueId}: ${error.message}`,
    );
  }
  if (!rows || rows.length === 0) return [];

  const listLimit = 1000;
  const files: { name: string }[] = [];
  for (let offset = 0; ; offset += listLimit) {
    const { data: page, error: listError } = await supabase.storage
      .from("comic-pages")
      .list(`${bookId}/${issueId}`, { limit: listLimit, offset });
    if (listError) {
      throw new Error(
        `storage list failed for ${bookId}/${issueId}: ${listError.message}`,
      );
    }
    const batch = page ?? [];
    files.push(...batch);
    if (batch.length < listLimit) break;
  }

  const present = new Set(
    files
      .map((f) => f.name.toLowerCase())
      .filter((name) => /^page-\d+\.webp$/.test(name)),
  );

  const missing: number[] = [];
  for (const row of rows) {
    const name = pageStoragePath(bookId, issueId, row.number as number)
      .split("/")
      .pop()!
      .toLowerCase();
    if (!present.has(name)) {
      missing.push(row.number as number);
    }
  }

  if (missing.length > 0) {
    throw new FatalError(
      `Missing WebP for ${bookId}/${issueId} page(s): ${missing.join(", ")}`,
    );
  }

  return rows.map((row) => ({
    pageNumber: row.number as number,
    width: row.width as number,
    height: row.height as number,
  }));
}

export async function updatePipelineStep(
  bookId: string,
  issueId: string,
  step: string,
  paused = false,
) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  const pauseUrl = paused ? getPauseUrl(bookId, issueId, step) : null;

  await updateIssue(supabase, bookId, issueId, {
    pipeline_step: step,
    pipeline_paused: paused,
    pipeline_paused_at: paused ? step : null,
    pipeline_paused_url: pauseUrl,
  });

  if (paused && pauseUrl) {
    await notifySlack(bookId, issueId, step, pauseUrl);
  }
}

export async function markPipelineFailed(
  bookId: string,
  issueId: string,
  currentStep: string,
) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  await updateIssue(supabase, bookId, issueId, {
    pipeline_step: `failed:${currentStep}`,
    pipeline_paused: false,
    pipeline_paused_at: null,
    pipeline_paused_url: null,
  });
}

function getPauseUrl(bookId: string, issueId: string, step: string): string {
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const base = vercelUrl
    ? `https://${vercelUrl}`
    : (process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000");
  switch (step) {
    case "review-clusters":
      return `${base}/admin/${bookId}/${issueId}/review/clusters`;
    case "review-pages":
      return `${base}/book/${bookId}/${issueId}/review?mode=pipeline`;
    case "review-new-characters":
      return `${base}/admin/${bookId}/${issueId}/review/new-characters`;
    case "casting":
      return `${base}/admin/characters/casting?book=${bookId}&issue=${issueId}`;
    default:
      return `${base}/admin`;
  }
}

const STEP_LABELS: Record<string, string> = {
  "review-clusters": "Character Cluster Review",
  "review-pages": "Page & Speaker Review",
  "review-new-characters": "New Character Review",
  casting: "Voice Casting",
};

async function notifySlack(
  bookId: string,
  issueId: string,
  step: string,
  reviewUrl: string,
) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) return;

  const label = STEP_LABELS[step] ?? step;
  const text = `📋 *Pipeline paused — ${label}*\n\`${bookId}/${issueId}\` is ready for review.\n<${reviewUrl}|Open review page>`;

  try {
    await globalThis.fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, text }),
    });
  } catch {
    console.warn(`[slack] Failed to notify for ${step} — continuing`);
  }
}

export async function getPageList(
  bookId: string,
  issueId: string,
): Promise<PageMeta[]> {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();
  return queryPageList(supabase, bookId, issueId);
}

export async function markIssueReady(bookId: string, issueId: string) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();

  await updateIssue(supabase, bookId, issueId, {
    pipeline_step: "complete",
    status: "ready",
    pipeline_paused: false,
    pipeline_paused_at: null,
    pipeline_paused_url: null,
  });
}

export async function getPanelCount(
  bookId: string,
  issueId: string,
): Promise<number> {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const { count } = await supabase
    .from("panels")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  return count ?? 0;
}

export function batchArray<T>(arr: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

/** Pure geometry, kept in `vision-rows.ts` so the reader's server code can
 * reach it without this module's `workflow` and client imports (#219).
 */
export { rdpSimplify } from "./vision-rows";
