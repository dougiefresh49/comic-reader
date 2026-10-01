// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// Read-only loader: SELECTs only, through the existing read helpers and clients.
import "server-only";
import { getIssueData } from "~/server";
import { getPanelsForIssue } from "~/server/pages/panels";
import { selectIssue } from "~/lib/issue-queries";
import { pageImageUrl } from "~/lib/storage";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { ROLES, slug, titleCase } from "./lib";
import type {
  BubbleType,
  CastMember,
  Face,
  ProtoData,
  Rect,
  SrcBubble,
  SrcPage,
  SrcPanel,
  VoiceOption,
} from "./types";

const DEFAULT_PAGE = { width: 1988, height: 3057 };
const SLOTS_TOTAL = 30;

export interface ProtoQuery {
  book: string;
  issue: string;
}

type SearchParams = Record<string, string | string[] | undefined>;

export function readQuery(sp: SearchParams): ProtoQuery {
  const pick = (v: string | string[] | undefined, fallback: string) =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  return {
    book: pick(sp.book, "smoke-test"),
    issue: pick(sp.issue, "issue-smoke"),
  };
}

interface IssueRow {
  name: string;
  status: string;
  pipeline_step: string | null;
  pipeline_paused: boolean;
  pipeline_paused_at: string | null;
  books: { name: string } | null;
}

interface PageRow {
  number: number;
  width: number;
  height: number;
}

interface DetectionRow {
  id: string;
  panel_id: string;
  character_id: string | null;
  identification_confidence: number;
  face_bbox: Partial<Rect> | null;
}

interface CharacterRow {
  id: string;
  display_name: string | null;
  aliases: string[] | null;
}

interface VoiceRow {
  id: string;
  display_name: string;
  status: string;
}

interface CastRow {
  character: string;
  voice_uuid: string | null;
}

function pct(value: string | undefined): number | null {
  if (!value) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n / 100 : null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

const TYPES: BubbleType[] = [
  "SPEECH",
  "NARRATION",
  "CAPTION",
  "SFX",
  "BACKGROUND",
];

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export async function loadProto(query: ProtoQuery): Promise<ProtoData | null> {
  const { book: bookId, issue: issueId } = query;

  const { data: issueData } = await selectIssue(
    supabaseAdmin,
    bookId,
    issueId,
    "name, status, pipeline_step, pipeline_paused, pipeline_paused_at, books(name)",
  ).maybeSingle();
  const issue = issueData as unknown as IssueRow | null;
  if (!issue) return null;

  const [
    { allBubbles },
    panelRows,
    { data: pageData },
    { data: charData },
    { data: voiceData },
    { data: castData },
  ] = await Promise.all([
    getIssueData(bookId, issueId),
    getPanelsForIssue(bookId, issueId),
    supabaseAdmin
      .from("pages")
      .select("number, width, height")
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .order("number"),
    supabaseAdmin.from("characters").select("id, display_name, aliases"),
    supabaseAdmin.from("voices").select("id, display_name, status"),
    supabaseAdmin
      .from("castlist")
      .select("character, voice_uuid")
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
  ]);

  const pageRows = (pageData ?? []) as PageRow[];
  const dims = new Map(pageRows.map((p) => [p.number, p]));

  // Bubbles: `style` already holds page percents; `box_2d` is page pixels.
  const bubbles: SrcBubble[] = [];
  for (const [key, list] of Object.entries(allBubbles)) {
    const page = parseInt(key.replace(/\D+/g, ""), 10);
    if (Number.isNaN(page)) continue;
    const d = dims.get(page) ?? DEFAULT_PAGE;
    for (const b of list) {
      const left = pct(b.style?.left);
      const top = pct(b.style?.top);
      const width = pct(b.style?.width);
      const height = pct(b.style?.height);
      const rect: Rect =
        left !== null && top !== null && width !== null && height !== null
          ? { x: left, y: top, w: width, h: height }
          : {
              x: clamp01((b.box_2d.x ?? 0) / d.width),
              y: clamp01((b.box_2d.y ?? 0) / d.height),
              w: clamp01((b.box_2d.width ?? d.width * 0.1) / d.width),
              h: clamp01((b.box_2d.height ?? d.height * 0.04) / d.height),
            };
      const confidence = (b.box_2d as { confidence?: unknown }).confidence;
      bubbles.push({
        id: b.id,
        page,
        rect,
        text: b.ocr_text,
        type: TYPES.includes(b.type) ? b.type : "SPEECH",
        speaker: b.speaker,
        emotion: b.emotion,
        ignored: b.ignored ?? false,
        confidence: typeof confidence === "number" ? confidence : null,
      });
    }
  }

  const panels: SrcPanel[] = panelRows.map((p) => ({
    id: p.id,
    page: p.pageNumber,
    rect: p.boundingBox,
    bubbleIds: p.bubbleIds,
  }));
  const panelById = new Map(panels.map((p) => [p.id, p]));

  // Pages: the `pages` rows, or whatever page numbers the rows mention.
  const pageNumbers = new Set<number>(pageRows.map((p) => p.number));
  for (const b of bubbles) pageNumbers.add(b.page);
  for (const p of panels) pageNumbers.add(p.page);
  const pages: SrcPage[] = Array.from(pageNumbers)
    .sort((a, b) => a - b)
    .map((number) => {
      const d = dims.get(number) ?? DEFAULT_PAGE;
      return {
        number,
        width: d.width,
        height: d.height,
        imageUrl: pageImageUrl(bookId, issueId, number),
      };
    });

  // Face detections hang off panels; ask in chunks to keep the URL short.
  const detectionRows: DetectionRow[] = [];
  for (const ids of chunk(
    panels.map((p) => p.id),
    60,
  )) {
    const { data } = await supabaseAdmin
      .from("panel_character_detections")
      .select(
        "id, panel_id, character_id, identification_confidence, face_bbox",
      )
      .in("panel_id", ids);
    detectionRows.push(...((data ?? []) as DetectionRow[]));
  }

  const faces: Face[] = [];
  for (const d of detectionRows) {
    const panel = panelById.get(d.panel_id);
    const f = d.face_bbox;
    if (!panel || !f) continue;
    faces.push({
      id: d.id,
      characterId: d.character_id,
      page: panel.page,
      panelId: panel.id,
      confidence: d.identification_confidence,
      rect: {
        x: panel.rect.x + (f.x ?? 0) * panel.rect.w,
        y: panel.rect.y + (f.y ?? 0) * panel.rect.h,
        w: (f.w ?? 0.1) * panel.rect.w,
        h: (f.h ?? 0.1) * panel.rect.h,
      },
    });
  }

  // Voices: an active voice of the same name first, then this issue's castlist.
  const voiceRows = (voiceData ?? []) as VoiceRow[];
  const active = voiceRows.filter((v) => v.status === "active");
  const voiceBySlug = new Map(active.map((v) => [slug(v.display_name), v]));
  const voiceById = new Map(voiceRows.map((v) => [v.id, v]));
  const castVoice = new Map<string, string>();
  for (const row of (castData ?? []) as CastRow[]) {
    const voice = row.voice_uuid ? voiceById.get(row.voice_uuid) : undefined;
    if (voice) castVoice.set(slug(row.character), voice.display_name);
  }
  const voiceFor = (id: string, name: string): string | null =>
    voiceBySlug.get(id)?.display_name ??
    voiceBySlug.get(slug(name))?.display_name ??
    castVoice.get(id) ??
    castVoice.get(slug(name)) ??
    null;

  const characters = new Map(
    ((charData ?? []) as CharacterRow[]).map((c) => [c.id, c]),
  );
  const pageAspect = (n: number) => {
    const d = dims.get(n) ?? DEFAULT_PAGE;
    return d.width / d.height;
  };

  const byCharacter = new Map<string, Face[]>();
  for (const f of faces) {
    if (!f.characterId) continue;
    const list = byCharacter.get(f.characterId) ?? [];
    list.push(f);
    byCharacter.set(f.characterId, list);
  }

  const cast: CastMember[] = [];
  for (const [id, list] of byCharacter) {
    const row = characters.get(id);
    const name = row?.display_name ?? titleCase(id);
    // The portrait is the most face-like box: close to square, not panel-sized.
    const best = list
      .map((f) => {
        const squareness = Math.abs(
          Math.log((f.rect.w * pageAspect(f.page)) / f.rect.h),
        );
        return { f, score: f.confidence - squareness - f.rect.h * 2 };
      })
      .sort((a, b) => b.score - a.score)[0];
    cast.push({
      id,
      name,
      aliases: row?.aliases ?? [],
      kind: "character",
      tint: 0,
      voice: voiceFor(id, name),
      faceCount: list.length,
      pages: Array.from(new Set(list.map((f) => f.page))).sort((a, b) => a - b),
      portrait: best ? { page: best.f.page, rect: best.f.rect } : null,
    });
  }
  cast.sort((a, b) => a.name.localeCompare(b.name));
  cast.forEach((member, i) => (member.tint = i));
  for (const role of ROLES) {
    cast.push({
      id: role.id,
      name: role.name,
      aliases: role.aliases,
      kind: "role",
      tint: 0,
      voice: voiceFor(role.id, role.name),
      faceCount: 0,
      pages: [],
      portrait: null,
    });
  }

  const voices: VoiceOption[] = active
    .map((v) => ({ id: v.id, name: v.display_name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    bookId,
    issueId,
    bookName: issue.books?.name ?? bookId,
    issueName: issue.name,
    run: {
      status: issue.status,
      step: issue.pipeline_step,
      paused: issue.pipeline_paused,
      pausedAt: issue.pipeline_paused_at,
    },
    pages,
    panels,
    bubbles,
    faces,
    cast,
    voices,
    slotsUsed: active.length,
    slotsTotal: SLOTS_TOTAL,
  };
}
