import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";
import type {
  PageDirectedPanel,
  PanelBoundingBox,
  PanelForegroundPolygons,
} from "~/types/panels";
import type { AudioTags } from "~/lib/panel-tags";

export interface PanelReviewBubble {
  /** uuid */
  id: string;
  legacyId: string | null;
  pageNumber: number;
  sortOrder: number;
  type: string;
  speaker: string | null;
  ocrText: string;
  /** uuid of assigned panel, or null if unassigned */
  panelId: string | null;
  /** % positions for rendering as a dot — same as bubbles.style */
  style: { left: string; top: string; width: string; height: string } | null;
}

export interface PanelReviewPage {
  pageNumber: number;
  imageUrl: string;
  panels: PageDirectedPanel[];
  bubbles: PanelReviewBubble[];
}

export interface PanelReviewData {
  bookId: string;
  issueId: string;
  bookName: string | null;
  issueNumber: number | null;
  issueName: string | null;
  pages: PanelReviewPage[];
}

interface PanelRow {
  id: string;
  panel_id: string;
  page_number: number;
  sort_order: number;
  bounding_box: PanelBoundingBox;
  cinematic_description: string | null;
  effect_tags: string[] | null;
  audio_tags: AudioTags | null;
  primary_speaker: string | null;
  estimated_duration_seconds: number | null;
  is_new_scene: boolean;
  source: string;
  foreground_polygons: PanelForegroundPolygons | null;
  scene_id: string | null;
}

interface BubbleRow {
  id: string;
  legacy_id: string | null;
  page_number: number;
  sort_order: number;
  type: string;
  speaker: string | null;
  ocr_text: string | null;
  panel_id: string | null;
  style: PanelReviewBubble["style"];
}

interface IssueMeta {
  number: number | null;
  name: string | null;
  page_count: number;
  bookName: string | null;
}

function pageImagePublicUrl(
  bookId: string,
  issueId: string,
  pageNum: number,
): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  const padded = String(pageNum).padStart(2, "0");
  return `${base}/storage/v1/object/public/comic-pages/${bookId}/${issueId}/page-${padded}.webp`;
}

export async function getPanelReviewData(
  bookId: string,
  issueId: string,
): Promise<PanelReviewData> {
  const [{ data: panelRows }, { data: bubbleRows }, { data: issueRow }] =
    await Promise.all([
      supabaseAdmin
        .from("panels")
        .select(
          "id, panel_id, page_number, sort_order, bounding_box, cinematic_description, effect_tags, audio_tags, primary_speaker, estimated_duration_seconds, is_new_scene, source, foreground_polygons, scene_id",
        )
        .eq("book_id", bookId)
        .eq("issue_id", issueId)
        .order("page_number")
        .order("sort_order"),
      supabaseAdmin
        .from("bubbles")
        .select(
          "id, legacy_id, page_number, sort_order, type, speaker, ocr_text, panel_id, style",
        )
        .eq("book_id", bookId)
        .eq("issue_id", issueId)
        .order("page_number")
        .order("sort_order"),
      supabaseAdmin
        .from("issues")
        .select("number, name, page_count, books(name)")
        .eq("book_id", bookId)
        .eq("id", issueId)
        .single(),
    ]);

  const panels = (panelRows ?? []) as PanelRow[];
  const bubbles = (bubbleRows ?? []) as BubbleRow[];

  const meta = (issueRow ?? null) as
    | (Omit<IssueMeta, "bookName"> & { books: { name: string } | null })
    | null;
  const pageCount = meta?.page_count ?? 0;

  // Build a page-keyed structure even if there are no panels yet.
  const pageMap = new Map<number, PanelReviewPage>();
  for (let n = 1; n <= pageCount; n++) {
    pageMap.set(n, {
      pageNumber: n,
      imageUrl: pageImagePublicUrl(bookId, issueId, n),
      panels: [],
      bubbles: [],
    });
  }

  for (const row of panels) {
    let page = pageMap.get(row.page_number);
    if (!page) {
      page = {
        pageNumber: row.page_number,
        imageUrl: pageImagePublicUrl(bookId, issueId, row.page_number),
        panels: [],
        bubbles: [],
      };
      pageMap.set(row.page_number, page);
    }
    page.panels.push({
      id: row.id,
      panelId: row.panel_id,
      pageNumber: row.page_number,
      sortOrder: row.sort_order,
      boundingBox: row.bounding_box,
      cinematicDescription: row.cinematic_description,
      effectTags: row.effect_tags ?? [],
      audioTags: row.audio_tags ?? {
        ambience: [],
        sfx: [],
        music_mood: "transition_neutral",
      },
      primarySpeaker: row.primary_speaker,
      estimatedDurationSeconds: row.estimated_duration_seconds,
      isNewScene: row.is_new_scene,
      source:
        row.source === "roboflow" || row.source === "manual"
          ? row.source
          : "gemini",
      bubbleIds: [],
      foregroundPolygons: row.foreground_polygons ?? null,
      sceneId: row.scene_id ?? null,
    });
  }

  for (const b of bubbles) {
    let page = pageMap.get(b.page_number);
    if (!page) {
      page = {
        pageNumber: b.page_number,
        imageUrl: pageImagePublicUrl(bookId, issueId, b.page_number),
        panels: [],
        bubbles: [],
      };
      pageMap.set(b.page_number, page);
    }
    page.bubbles.push({
      id: b.id,
      legacyId: b.legacy_id,
      pageNumber: b.page_number,
      sortOrder: b.sort_order,
      type: b.type,
      speaker: b.speaker,
      ocrText: b.ocr_text ?? "",
      panelId: b.panel_id,
      style: b.style ?? null,
    });
    if (b.panel_id) {
      const panel = page.panels.find((p) => p.id === b.panel_id);
      if (panel) panel.bubbleIds.push(b.id);
    }
  }

  return {
    bookId,
    issueId,
    bookName: meta?.books?.name ?? null,
    issueNumber: meta?.number ?? null,
    issueName: meta?.name ?? null,
    pages: Array.from(pageMap.values()).sort(
      (a, b) => a.pageNumber - b.pageNumber,
    ),
  };
}
