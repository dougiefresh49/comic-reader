// THROWAWAY spike prototype for comic-reader #325, variant D (the reel).
// Siloed under src/app/admin/proto/d/ — never merged.
//
// Server component. Reads the issue with SELECTs through the existing admin
// read helpers and hands the client a plain serializable shape. It writes
// nothing and calls nothing paid.

import { getPanelReviewData } from "~/server/admin/panel-review";
import { getIssueData } from "~/server";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { ReelClient } from "./ReelClient";
import type { ClipData, EditorData, PageData, PanelData, Rect } from "./data";
import { containment } from "./data";

export const dynamic = "force-dynamic";

function percentToFraction(value: string | undefined): number | null {
  if (!value) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n / 100 : null;
}

export default async function ReelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const bookId = typeof sp.book === "string" ? sp.book : "smoke-test";
  const issueId = typeof sp.issue === "string" ? sp.issue : "issue-smoke";

  const [panelData, issueData, pageRows] = await Promise.all([
    getPanelReviewData(bookId, issueId),
    getIssueData(bookId, issueId),
    supabaseAdmin
      .from("pages")
      .select("number, width, height")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
  ]);

  // getIssueData keys its bubbles by "page-NN.jpg"; flatten to a list so a
  // row can be joined to its panel row by id.
  const issueBubbles = Object.values(issueData.allBubbles).flat();
  const extraById = new Map(issueBubbles.map((b) => [b.id, b]));

  // Page pixel dimensions: bubbles store box_2d in page pixels and panels
  // store page fractions, so the two only meet once the page is measured.
  const dims = new Map<number, { width: number; height: number }>();
  for (const row of (pageRows.data ?? []) as Array<{
    number: number;
    width: number;
    height: number;
  }>) {
    dims.set(row.number, { width: row.width, height: row.height });
  }

  const pages: PageData[] = panelData.pages.map((p) => {
    const d = dims.get(p.pageNumber) ?? { width: 1000, height: 1400 };
    return {
      number: p.pageNumber,
      imageUrl: p.imageUrl,
      width: d.width,
      height: d.height,
    };
  });

  const panels: PanelData[] = [];
  const clips: ClipData[] = [];
  const seenPanels = new Set<string>();

  for (const page of panelData.pages) {
    const dim = dims.get(page.pageNumber) ?? { width: 1000, height: 1400 };
    for (const panel of page.panels) {
      if (seenPanels.has(panel.id)) continue;
      seenPanels.add(panel.id);
      panels.push({
        id: panel.id,
        pageNumber: page.pageNumber,
        sortOrder: panel.sortOrder,
        box: {
          x: panel.boundingBox.x,
          y: panel.boundingBox.y,
          w: panel.boundingBox.w,
          h: panel.boundingBox.h,
        },
      });
    }

    for (const b of page.bubbles) {
      const extra = extraById.get(b.id);
      let box: Rect | null = null;
      const px = extra?.box_2d?.x;
      const py = extra?.box_2d?.y;
      const pw = extra?.box_2d?.width;
      const ph = extra?.box_2d?.height;
      if (
        typeof px === "number" &&
        typeof py === "number" &&
        typeof pw === "number" &&
        typeof ph === "number"
      ) {
        box = {
          x: px / dim.width,
          y: py / dim.height,
          w: pw / dim.width,
          h: ph / dim.height,
        };
      } else if (b.style) {
        const l = percentToFraction(b.style.left);
        const t = percentToFraction(b.style.top);
        const w = percentToFraction(b.style.width);
        const h = percentToFraction(b.style.height);
        if (l !== null && t !== null && w !== null && h !== null) {
          box = { x: l, y: t, w, h };
        }
      }
      clips.push({
        id: b.id,
        pageNumber: page.pageNumber,
        panelId: b.panelId,
        text: b.ocrText,
        speaker: b.speaker,
        emotion: extra?.emotion ?? "",
        type: (b.type || "speech").toLowerCase(),
        ignored: Boolean(extra?.ignored),
        silent: false,
        box,
        order: b.sortOrder,
      });
    }
  }

  // Every smoke bubble carries panel_id null, so a bubble's panel is computed
  // by which panel box it sits most inside. A bubble with no box at all, or
  // one that overlaps nothing, keeps panelId null and the lane shows it in
  // its own "no panel" group.
  for (const clip of clips) {
    if (clip.panelId || !clip.box) continue;
    const ownPage = panels.filter((p) => p.pageNumber === clip.pageNumber);
    let bestId: string | null = null;
    let bestScore = 0;
    for (const panel of ownPage) {
      const score = containment(clip.box, panel.box);
      if (score > bestScore) {
        bestScore = score;
        bestId = panel.id;
      }
    }
    clip.panelId = bestId;
  }

  const data: EditorData = {
    bookId,
    bookName: panelData.bookName ?? bookId,
    issueId,
    issueName: panelData.issueName ?? issueId,
    pageCount: panelData.pages.length,
    pages,
    panels,
    clips,
    characters: issueData.characters,
  };

  // ?page= and ?view= let the owner link straight to a page or the full-page
  // view, which is also how the screenshots for the round were taken.
  const wantPage = typeof sp.page === "string" ? parseInt(sp.page, 10) : NaN;
  const initialPage = data.pages.some((p) => p.number === wantPage)
    ? wantPage
    : (data.pages[0]?.number ?? 1);

  return (
    <ReelClient
      data={data}
      initialPage={initialPage}
      initialFullPage={sp.view === "full"}
    />
  );
}
