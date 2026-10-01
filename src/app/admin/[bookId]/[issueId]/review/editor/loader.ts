// Loads one issue for the review editor: pages, panels, bubbles, face detections and the cast. SELECTs only.
import "server-only";
import { getIssueData } from "~/server";
import { getPanelsForIssue } from "~/server/pages/panels";
import { selectIssue } from "~/lib/issue-queries";
import { pageImageUrl } from "~/lib/storage";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { ROLES, slug, titleCase } from "~/components/review-editor/lib";
import type {
  BubbleType,
  CastMember,
  EditorData,
  Face,
  KnownCharacter,
  Rect,
  SrcBubble,
  SrcPage,
  SrcPanel,
  VoiceOption,
} from "~/components/review-editor/types";

const DEFAULT_PAGE = { width: 1988, height: 3057 };
/** The ElevenLabs voice slots this repo shares with the owner's other projects. */
const SLOTS_TOTAL = 30;

interface IssueRow {
  name: string;
  wiki_appearances: unknown;
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
  issue_id: string;
  character: string;
  voice_uuid: string | null;
}

interface CastEntry {
  id: string;
  name: string;
  aliases: Set<string>;
  faces: Face[];
}

const TYPES: BubbleType[] = [
  "SPEECH",
  "NARRATION",
  "CAPTION",
  "SFX",
  "BACKGROUND",
];

function pct(value: string | undefined): number | null {
  if (!value) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n / 100 : null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

function report(what: string, error: unknown): void {
  if (error) console.error(`review editor loader, ${what}:`, error);
}

/** `issues.wiki_appearances` as name and qualifier pairs, whatever the JSON holds. */
function wikiNames(value: unknown): { name: string; qualifier: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const { name, qualifier } = entry as {
      name?: unknown;
      qualifier?: unknown;
    };
    if (typeof name !== "string" || !name.trim()) return [];
    return [
      {
        name: name.trim(),
        qualifier: typeof qualifier === "string" ? qualifier.trim() : "",
      },
    ];
  });
}

export async function loadEditor(
  bookId: string,
  issueId: string,
): Promise<EditorData | null> {
  const { data: issueData, error: issueError } = await selectIssue(
    supabaseAdmin,
    bookId,
    issueId,
    "name, wiki_appearances, books(name)",
  ).maybeSingle();
  report("issue", issueError);
  const issue = issueData as unknown as IssueRow | null;
  if (!issue) return null;

  const [{ allBubbles }, panelRows, pageResult, charResult, voiceResult, cast] =
    await Promise.all([
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
      // The whole book's rows: a character cast in any issue is in the list.
      supabaseAdmin
        .from("castlist")
        .select("issue_id, character, voice_uuid")
        .eq("book_id", bookId),
    ]);
  report("pages", pageResult.error);
  report("characters", charResult.error);
  report("voices", voiceResult.error);
  report("castlist", cast.error);

  const pageRows = (pageResult.data ?? []) as PageRow[];
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
    const { data, error } = await supabaseAdmin
      .from("panel_character_detections")
      .select(
        "id, panel_id, character_id, identification_confidence, face_bbox",
      )
      .in("panel_id", ids);
    report("face detections", error);
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

  // Voices: an active voice of the same name first, then the book's castlist
  // with this issue's rows ahead of the other issues'.
  const voiceRows = (voiceResult.data ?? []) as VoiceRow[];
  const active = voiceRows.filter((v) => v.status === "active");
  const voiceBySlug = new Map(active.map((v) => [slug(v.display_name), v]));
  const activeById = new Map(active.map((v) => [v.id, v]));
  const castRows = ((cast.data ?? []) as CastRow[])
    .slice()
    .sort(
      (a, b) => Number(b.issue_id === issueId) - Number(a.issue_id === issueId),
    );
  const castVoice = new Map<string, string>();
  for (const row of castRows) {
    const voice = row.voice_uuid ? activeById.get(row.voice_uuid) : undefined;
    const key = slug(row.character);
    if (voice && !castVoice.has(key)) castVoice.set(key, voice.display_name);
  }
  const ownVoice = (id: string, name: string): string | null =>
    voiceBySlug.get(id)?.display_name ??
    voiceBySlug.get(slug(name))?.display_name ??
    null;
  const voiceFor = (id: string, name: string): string | null =>
    ownVoice(id, name) ??
    castVoice.get(id) ??
    castVoice.get(slug(name)) ??
    null;

  // A name means a `characters` row when it is the row's id, display name or alias.
  const charRows = (charResult.data ?? []) as CharacterRow[];
  const rowByKey = new Map<string, CharacterRow>();
  const index = (key: string, row: CharacterRow) => {
    if (key && !rowByKey.has(key)) rowByKey.set(key, row);
  };
  for (const row of charRows) index(row.id, row);
  for (const row of charRows) index(slug(row.display_name ?? ""), row);
  for (const row of charRows)
    for (const alias of row.aliases ?? []) index(slug(alias), row);

  const isRole = (key: string) =>
    ROLES.some(
      (r) =>
        r.id === key ||
        slug(r.name) === key ||
        r.aliases.some((a) => slug(a) === key),
    );

  // The closed list (decisions row 237): characters with a face in this issue,
  // characters the book has cast in any issue, and the wiki's names. The three
  // roles are appended below.
  const entries = new Map<string, CastEntry>();
  const ensure = (raw: string): CastEntry | null => {
    const key = slug(raw);
    if (!key || isRole(key)) return null;
    const row = rowByKey.get(key);
    const id = row?.id ?? key;
    if (isRole(id)) return null;
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        id,
        name: row?.display_name ?? (raw === key ? titleCase(raw) : raw.trim()),
        aliases: new Set(row?.aliases ?? []),
        faces: [],
      };
      entries.set(id, entry);
    }
    return entry;
  };
  for (const f of faces) {
    if (f.characterId) ensure(f.characterId)?.faces.push(f);
  }
  for (const row of castRows) ensure(row.character);
  for (const { name, qualifier } of wikiNames(issue.wiki_appearances)) {
    // "Kimberly Hart (Pink Ranger)": a name no row knows joins the row its
    // qualifier names, as an alias, and does not become a second entry.
    const folds =
      !rowByKey.has(slug(name)) && qualifier && rowByKey.has(slug(qualifier));
    if (folds) ensure(qualifier)?.aliases.add(name);
    else ensure(name);
  }

  const pageAspect = (n: number) => {
    const d = dims.get(n) ?? DEFAULT_PAGE;
    return d.width / d.height;
  };
  const members: CastMember[] = [];
  for (const entry of entries.values()) {
    // The portrait is the most face-like box: close to square, not panel-sized.
    const best = entry.faces
      .map((f) => {
        const squareness = Math.abs(
          Math.log((f.rect.w * pageAspect(f.page)) / f.rect.h),
        );
        return { f, score: f.confidence - squareness - f.rect.h * 2 };
      })
      .sort((a, b) => b.score - a.score)[0];
    members.push({
      id: entry.id,
      name: entry.name,
      aliases: Array.from(entry.aliases),
      kind: "character",
      tint: 0,
      voice: voiceFor(entry.id, entry.name),
      faceCount: entry.faces.length,
      pages: Array.from(new Set(entry.faces.map((f) => f.page))).sort(
        (a, b) => a - b,
      ),
      portrait: best ? { page: best.f.page, rect: best.f.rect } : null,
    });
  }
  members.sort((a, b) => a.name.localeCompare(b.name));
  members.forEach((member, i) => (member.tint = i));
  for (const role of ROLES) {
    members.push({
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

  const known: KnownCharacter[] = charRows.map((row) => {
    const name = row.display_name ?? titleCase(row.id);
    return {
      id: row.id,
      name,
      aliases: row.aliases ?? [],
      voice: ownVoice(row.id, name),
    };
  });

  const voices: VoiceOption[] = active
    .map((v) => ({ id: v.id, name: v.display_name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    bookId,
    issueId,
    bookName: issue.books?.name ?? bookId,
    issueName: issue.name,
    pages,
    panels,
    bubbles,
    faces,
    cast: members,
    known,
    voices,
    slotsUsed: active.length,
    slotsTotal: SLOTS_TOTAL,
  };
}
