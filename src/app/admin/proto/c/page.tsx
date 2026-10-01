// THROWAWAY prototype for issue #325. SELECTs only; all edits stay in browser memory.
import { notFound } from "next/navigation";
import { getIssueData } from "~/server";
import { getPanelsForIssue } from "~/server/pages/panels";
import { getPipelineReviewIssue } from "~/server/admin/pipeline-review";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { pageImageUrl } from "~/lib/storage";
import { sortPanelsForReading } from "~/lib/panel-reading-order";
import { ScriptEditor } from "./script-editor";
import type { ScriptPage } from "./types";

export const dynamic = "force-dynamic";

export default async function Prototype({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const book = typeof query.book === "string" ? query.book : "smoke-test";
  const issue = typeof query.issue === "string" ? query.issue : "issue-smoke";
  const [metadata, { allBubbles }, panels, stored] = await Promise.all([
    getPipelineReviewIssue(book, issue),
    getIssueData(book, issue),
    getPanelsForIssue(book, issue),
    supabaseAdmin
      .from("pages")
      .select("number, width, height")
      .eq("book_id", book)
      .eq("issue_id", issue)
      .order("number"),
  ]);
  if (!metadata) notFound();
  if (stored.error) throw new Error("Could not read page dimensions");
  const faces = panels.length
    ? await supabaseAdmin
        .from("panel_character_detections")
        .select("character_id, suggested_name")
        .in(
          "panel_id",
          panels.map((p) => p.id),
        )
    : { data: [], error: null };
  if (faces.error) throw new Error("Could not read the detected cast");
  const cast = Array.from(
    new Set(
      (
        faces.data as Array<{
          character_id: string | null;
          suggested_name: string | null;
        }>
      )
        .map((f) => f.character_id ?? f.suggested_name)
        .filter((name): name is string => !!name),
    ),
  );
  const dimensions = stored.data as Array<{
    number: number;
    width: number;
    height: number;
  }>;
  const count = Math.max(
    metadata.pageCount,
    ...dimensions.map((p) => p.number),
    1,
  );
  const pages: ScriptPage[] = Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const size = dimensions.find((p) => p.number === number);
    const pagePanels = sortPanelsForReading(
      panels.filter((p) => p.pageNumber === number),
    );
    const pageBubbles =
      allBubbles[`page-${String(number).padStart(2, "0")}.jpg`] ?? [];
    return {
      number,
      image: pageImageUrl(book, issue, number),
      width: size?.width ?? 1000,
      height: size?.height ?? 1500,
      panels: pagePanels.map((p) => ({ id: p.id, box: p.boundingBox })),
      bubbles: pageBubbles.map((b) => {
        const style = b.style;
        const raw = b.box_2d;
        const box = style
          ? {
              x: parseFloat(String(style.left)) / 100,
              y: parseFloat(String(style.top)) / 100,
              w: parseFloat(String(style.width)) / 100,
              h: parseFloat(String(style.height)) / 100,
            }
          : raw.x !== undefined
            ? {
                x: (raw.x ?? 0) / (size?.width ?? 1000),
                y: (raw.y ?? 0) / (size?.height ?? 1500),
                w: (raw.width ?? 0) / (size?.width ?? 1000),
                h: (raw.height ?? 0) / (size?.height ?? 1500),
              }
            : { x: 0.05, y: 0.05, w: 0.15, h: 0.08 };
        return {
          id: b.id,
          text: b.ocr_text,
          speaker: b.speaker ?? "",
          emotion: b.emotion ?? "",
          type: b.type.toLowerCase(),
          ignored: b.ignored ?? false,
          silent: false,
          box,
          panel: pagePanels.find((p) => p.bubbleIds.includes(b.id))?.id ?? "",
          duplicateDismissed: false,
        };
      }),
    };
  });
  return (
    <ScriptEditor
      title={metadata.name}
      book={book}
      issue={issue}
      initialPages={pages}
      initialCast={cast}
    />
  );
}
