// THROWAWAY spike for issue #325 (review editor variant B, the triage queue). Read-only: SELECTs only.

import { getIssueData, getManifest, getStoredPageCounts } from "~/server";
import { getPanelsForIssue } from "~/server/pages/panels";
import { sortPanelsForReading } from "~/lib/panel-reading-order";
import { pageImageUrl } from "~/lib/storage";
import { supabase } from "~/lib/supabase";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { TriageEditor } from "./TriageEditor";
import type {
  BubbleType,
  CastMember,
  ProtoBubble,
  ProtoData,
  ProtoPage,
  ProtoPanel,
} from "./types";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function str(v: string | string[] | undefined, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function titleCase(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function pct(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n / 100 : null;
}

async function load(bookId: string, issueId: string): Promise<ProtoData> {
  const [manifest, stored, issueData, panelRows] = await Promise.all([
    getManifest(),
    getStoredPageCounts(bookId),
    getIssueData(bookId, issueId),
    getPanelsForIssue(bookId, issueId),
  ]);
  const issue = manifest.books
    .find((b) => b.id === bookId)
    ?.issues.find((i) => i.id === issueId);

  // The shared helpers drop panel_id, so read it beside them.
  const [{ data: linkRows }, { data: pageRows }] = await Promise.all([
    supabase
      .from("bubbles")
      .select("id, panel_id")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    supabaseAdmin
      .from("pages")
      .select("number, width, height")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
  ]);
  const panelLink = new Map(
    ((linkRows ?? []) as { id: string; panel_id: string | null }[]).map((r) => [
      r.id,
      r.panel_id,
    ]),
  );
  const dims = new Map(
    (
      (pageRows ?? []) as { number: number; width: number; height: number }[]
    ).map((r) => [r.number, r]),
  );

  const panelIds = panelRows.map((p) => p.id);
  const faceRows: {
    panel_id: string;
    character_id: string | null;
    suggested_name: string | null;
  }[] = [];
  for (let i = 0; i < panelIds.length; i += 100) {
    const { data } = await supabaseAdmin
      .from("panel_character_detections")
      .select("panel_id, character_id, suggested_name")
      .in("panel_id", panelIds.slice(i, i + 100));
    faceRows.push(...((data ?? []) as typeof faceRows));
  }
  const facesByPanel = new Map<string, Map<string, number>>();
  const castIds = new Set<string>();
  for (const r of faceRows) {
    const id = r.character_id ?? r.suggested_name;
    if (!id) continue;
    castIds.add(id);
    const m = facesByPanel.get(r.panel_id) ?? new Map<string, number>();
    m.set(id, (m.get(id) ?? 0) + 1);
    facesByPanel.set(r.panel_id, m);
  }

  const { data: charRows } = castIds.size
    ? await supabaseAdmin
        .from("characters")
        .select("id, display_name, aliases")
        .in("id", [...castIds])
    : { data: [] };
  const charInfo = new Map(
    (
      (charRows ?? []) as {
        id: string;
        display_name: string | null;
        aliases: string[] | null;
      }[]
    ).map((c) => [c.id, c]),
  );
  const cast: CastMember[] = [...castIds].sort().map((id) => {
    const c = charInfo.get(id);
    return {
      id,
      name: c?.display_name ?? titleCase(id),
      aliases: c?.aliases ?? [],
      kind: "cast",
    };
  });

  const bubbles: ProtoBubble[] = [];
  const order: Record<number, string[]> = {};
  let maxBubblePage = 0;
  const rawByPage = Object.entries(issueData.allBubbles);
  for (const [key, list] of rawByPage) {
    const page = parseInt(key.replace(/\D+/g, ""), 10);
    if (!Number.isFinite(page)) continue;
    maxBubblePage = Math.max(maxBubblePage, page);
    for (const b of list) {
      // Page size: the pages row, else inferred from box_2d over style %.
      let d = dims.get(page);
      const left = pct(b.style?.left);
      const top = pct(b.style?.top);
      if (!d && left && top && b.box_2d.x && b.box_2d.y) {
        d = {
          number: page,
          width: Math.round(b.box_2d.x / left),
          height: Math.round(b.box_2d.y / top),
        };
        dims.set(page, d);
      }
      const W = d?.width ?? 1988;
      const H = d?.height ?? 3057;
      const box =
        b.box_2d.x !== undefined && b.box_2d.width
          ? {
              x: b.box_2d.x / W,
              y: (b.box_2d.y ?? 0) / H,
              w: b.box_2d.width / W,
              h: (b.box_2d.height ?? 0) / H,
            }
          : {
              x: left ?? 0,
              y: top ?? 0,
              w: pct(b.style?.width) ?? 0.1,
              h: pct(b.style?.height) ?? 0.05,
            };
      const conf = (b.box_2d as { confidence?: number }).confidence;
      bubbles.push({
        id: b.id,
        page,
        text: b.ocr_text,
        type: (b.type ?? "SPEECH") as BubbleType,
        speaker: b.speaker,
        emotion: b.emotion,
        ignored: !!b.ignored,
        silent: false,
        box,
        confidence: typeof conf === "number" ? conf : null,
        panelId: panelLink.get(b.id) ?? null,
      });
      (order[page] ??= []).push(b.id);
    }
  }

  const byPage = new Map<number, typeof panelRows>();
  for (const p of panelRows)
    byPage.set(p.pageNumber, [...(byPage.get(p.pageNumber) ?? []), p]);
  const panels: ProtoPanel[] = [];
  for (const [page, list] of byPage) {
    sortPanelsForReading(list).forEach((p, i) => {
      const faces = [
        ...(facesByPanel.get(p.id) ?? new Map<string, number>()).entries(),
      ]
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
      panels.push({ id: p.id, page, order: i, box: p.boundingBox, faces });
    });
  }

  const pageCount = Math.max(
    issue?.pageCount ?? 0,
    stored[bookId]?.[issueId] ?? 0,
    maxBubblePage,
  );
  const pages: ProtoPage[] = [];
  for (let n = 1; n <= pageCount; n++) {
    const d = dims.get(n);
    pages.push({
      number: n,
      width: d?.width ?? 1988,
      height: d?.height ?? 3057,
      imageUrl: pageImageUrl(bookId, issueId, n),
    });
  }

  return {
    bookId,
    issueId,
    issueName: issue?.name ?? issueId,
    pages,
    panels,
    bubbles,
    order,
    cast,
    loadNote: !issue
      ? `No issue ${issueId} in book ${bookId}.`
      : pages.length === 0
        ? "This issue has no pages."
        : null,
  };
}

export default async function ProtoBPage({ searchParams }: Props) {
  const sp = await searchParams;
  const bookId = str(sp.book, "smoke-test");
  const issueId = str(sp.issue, "issue-smoke");
  const data = await load(bookId, issueId);
  return <TriageEditor key={`${bookId}/${issueId}`} data={data} />;
}
