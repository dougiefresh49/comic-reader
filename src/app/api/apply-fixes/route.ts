import "server-only";
import { revalidatePath } from "next/cache";
import { type NextRequest } from "next/server";
import { supabaseAdmin } from "~/lib/supabase-admin";

interface BubbleStyle {
  left: string;
  top: string;
  width: string;
  height: string;
}

interface FixBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FixChanges {
  speaker?: string | null;
  emotion?: string;
  ocr_text?: string;
  type?: string;
  textWithCues?: string;
  ignored?: boolean;
  bounds?: FixBounds;
}

type FixEntry =
  | { bubbleId: string; action: "update"; changes: FixChanges }
  | { bubbleId: string; action: "delete" }
  | {
      bubbleId: string;
      action: "add";
      pageIndex: number;
      data: FixChanges & {
        ocr_text?: string;
        speaker?: string | null;
        emotion?: string;
        type?: string;
        textWithCues?: string;
      };
    }
  | {
      bubbleId: "__page-reorder__";
      action: "reorder";
      pageIndex: number;
      orderedIds: string[];
    };

interface FixesJson {
  bookId: string;
  issueId: string;
  fixes: FixEntry[];
}

const AUDIO_AFFECTING_FIELDS = new Set<string>([
  "speaker",
  "ocr_text",
  "textWithCues",
  "type",
]);

function boundsToStyle(b: FixBounds): BubbleStyle {
  return {
    left: `${(b.x * 100).toFixed(2)}%`,
    top: `${(b.y * 100).toFixed(2)}%`,
    width: `${(b.width * 100).toFixed(2)}%`,
    height: `${(b.height * 100).toFixed(2)}%`,
  };
}

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}

async function resolveBubbleUuid(
  bookId: string,
  issueId: string,
  bubbleId: string,
): Promise<string | null> {
  if (isUuid(bubbleId)) return bubbleId;
  const { data, error } = await supabaseAdmin
    .from("bubbles")
    .select("id")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("legacy_id", bubbleId)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { id: string }).id;
}

function pageNumFromIndex(idx: number): number {
  return idx;
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-apply-fixes-secret");
  if (!process.env.APPLY_FIXES_SECRET) {
    return Response.json(
      { error: "APPLY_FIXES_SECRET not configured" },
      { status: 500 },
    );
  }
  if (secret !== process.env.APPLY_FIXES_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: FixesJson;
  try {
    payload = (await req.json()) as FixesJson;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { bookId, issueId, fixes } = payload;
  if (!bookId || !issueId || !Array.isArray(fixes)) {
    return Response.json({ error: "Invalid fixes payload" }, { status: 400 });
  }

  const results = {
    applied: 0,
    skipped: [] as string[],
    needsAudio: 0,
  };

  const audioAffectedUuids = new Set<string>();

  for (const fix of fixes) {
    try {
      if (fix.action === "delete") {
        const uuid = await resolveBubbleUuid(bookId, issueId, fix.bubbleId);
        if (!uuid) {
          results.skipped.push(`delete:${fix.bubbleId} (not found)`);
          continue;
        }
        const { error } = await supabaseAdmin
          .from("bubbles")
          .delete()
          .eq("id", uuid);
        if (error) {
          results.skipped.push(`delete:${fix.bubbleId} (${error.message})`);
        } else {
          results.applied += 1;
        }
        continue;
      }

      if (fix.action === "update") {
        const uuid = await resolveBubbleUuid(bookId, issueId, fix.bubbleId);
        if (!uuid) {
          results.skipped.push(`update:${fix.bubbleId} (not found)`);
          continue;
        }
        const { bounds, textWithCues, ...rest } = fix.changes;
        const patch: Record<string, unknown> = {};
        if (rest.speaker !== undefined) patch.speaker = rest.speaker;
        if (rest.ocr_text !== undefined) patch.ocr_text = rest.ocr_text;
        if (textWithCues !== undefined) patch.text_with_cues = textWithCues;
        if (rest.type !== undefined) patch.type = rest.type;
        if (rest.emotion !== undefined) patch.emotion = rest.emotion;
        if (rest.ignored !== undefined) patch.ignored = rest.ignored;
        if (bounds) patch.style = boundsToStyle(bounds);

        const affectsAudio = Object.keys(fix.changes).some((k) =>
          AUDIO_AFFECTING_FIELDS.has(k),
        );
        if (affectsAudio && rest.ignored !== true) {
          patch.needs_audio = true;
          audioAffectedUuids.add(uuid);
        }

        const { error } = await supabaseAdmin
          .from("bubbles")
          .update(patch)
          .eq("id", uuid);
        if (error) {
          results.skipped.push(`update:${fix.bubbleId} (${error.message})`);
        } else {
          results.applied += 1;
        }
        continue;
      }

      if (fix.action === "add") {
        const pageNum = pageNumFromIndex(fix.pageIndex);
        const { data: existing } = await supabaseAdmin
          .from("bubbles")
          .select("sort_order")
          .eq("book_id", bookId)
          .eq("issue_id", issueId)
          .eq("page_number", pageNum)
          .order("sort_order", { ascending: false })
          .limit(1)
          .maybeSingle();
        const nextSort =
          ((existing as { sort_order?: number } | null)?.sort_order ?? -1) + 1;

        const { bounds, textWithCues, ...rest } = fix.data;
        const hasText = !!(rest.ocr_text?.trim() ?? textWithCues?.trim());
        const insertRow: Record<string, unknown> = {
          legacy_id: fix.bubbleId,
          book_id: bookId,
          issue_id: issueId,
          page_number: pageNum,
          sort_order: nextSort,
          ocr_text: rest.ocr_text ?? null,
          text_with_cues: textWithCues ?? null,
          type: rest.type ?? "SPEECH",
          speaker: rest.speaker ?? null,
          emotion: rest.emotion ?? null,
          ignored: rest.ignored ?? false,
          needs_audio: true,
          needs_ocr: !hasText,
          style: bounds ? boundsToStyle(bounds) : null,
          box_2d: null,
        };
        const { data: ins, error } = await supabaseAdmin
          .from("bubbles")
          .insert(insertRow)
          .select("id")
          .single();
        if (error) {
          results.skipped.push(`add:${fix.bubbleId} (${error.message})`);
        } else {
          results.applied += 1;
          const id = (ins as { id?: string } | null)?.id;
          if (id) {
            audioAffectedUuids.add(id);
            await supabaseAdmin
              .from("bubbles")
              .update({ audio_storage_path: `${id}.mp3` })
              .eq("id", id);
          }
        }
        continue;
      }

      if (fix.action === "reorder") {
        for (let i = 0; i < fix.orderedIds.length; i++) {
          const id = fix.orderedIds[i]!;
          const uuid = await resolveBubbleUuid(bookId, issueId, id);
          if (!uuid) {
            results.skipped.push(`reorder:${id} (not found)`);
            continue;
          }
          const { error } = await supabaseAdmin
            .from("bubbles")
            .update({ sort_order: i })
            .eq("id", uuid);
          if (error) {
            results.skipped.push(`reorder:${id} (${error.message})`);
          } else {
            results.applied += 1;
          }
        }
        continue;
      }
    } catch (e) {
      results.skipped.push(
        `${fix.action}:${"bubbleId" in fix ? fix.bubbleId : "?"} (${(e as Error).message})`,
      );
    }
  }

  results.needsAudio = audioAffectedUuids.size;

  // Invalidate ISR cache
  revalidatePath(`/book/${bookId}/${issueId}`, "page");
  revalidatePath(`/book/${bookId}/${issueId}/review`, "page");
  revalidatePath(`/book/${bookId}`, "page");
  revalidatePath("/", "page");

  return Response.json(results);
}
