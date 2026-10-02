// Loads one issue for the review editor: pages, panels, bubbles, face detections and the cast. SELECTs only.
import "server-only";
import { selectIssue } from "~/lib/issue-queries";
import { pageImageUrl } from "~/lib/storage";
import { DEFAULT_PAGE } from "~/app/api/apply-fixes/write-rules";
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

interface BubbleRow {
  id: string;
  page_number: number;
  panel_id: string | null;
  ocr_text: string | null;
  text_with_cues: string | null;
  type: string;
  speaker: string | null;
  emotion: string | null;
  ignored: boolean | null;
  silent: boolean | null;
  box_2d: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    confidence?: unknown;
  } | null;
  style: {
    left?: string;
    top?: string;
    width?: string;
    height?: string;
  } | null;
}

interface PanelRow {
  id: string;
  page_number: number;
  bounding_box: Rect;
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
  character_id: string | null;
}

interface CastRow {
  issue_id: string;
  character: string;
  character_id: string | null;
  voice_uuid: string | null;
}

interface CastEntry {
  id: string;
  name: string;
  aliases: Set<string>;
  faces: Face[];
}

const TYPES: string[] = [
  "SPEECH",
  "NARRATION",
  "CAPTION",
  "SFX",
  "BACKGROUND",
] satisfies BubbleType[];

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

/**
 * The rows of one read, or a throw. The editor stores edits against what it
 * loaded, so a failed or cut-short read must fail the page (Next shows its
 * error page) and never render with rows missing.
 */
function rows<T>(
  what: string,
  result: { data: unknown; error: unknown; count?: number | null },
): T[] {
  if (result.error) {
    console.error(`review editor loader, ${what}:`, result.error);
    throw new Error(`The review editor could not read ${what}.`);
  }
  const data = (result.data ?? []) as T[];
  if (typeof result.count === "number" && result.count > data.length) {
    throw new Error(
      `The review editor read ${data.length} of ${result.count} ${what}.`,
    );
  }
  return data;
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
  const issueResult = await selectIssue(
    supabaseAdmin,
    bookId,
    issueId,
    "name, wiki_appearances, books(name)",
  ).maybeSingle();
  if (issueResult.error) {
    console.error("review editor loader, the issue:", issueResult.error);
    throw new Error("The review editor could not read the issue.");
  }
  const issue = issueResult.data as unknown as IssueRow | null;
  if (!issue) return null;

  // Bubbles and panels are read here, not through `getIssueData` and
  // `getPanelsForIssue`: those log a failed read and return nothing.
  const [
    bubbleResult,
    panelResult,
    pageResult,
    charResult,
    voiceResult,
    castResult,
  ] = await Promise.all([
    supabaseAdmin
      .from("bubbles")
      .select(
        "id, page_number, panel_id, ocr_text, text_with_cues, type, speaker, emotion, ignored, silent, box_2d, style",
        { count: "exact" },
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .order("page_number")
      .order("sort_order"),
    supabaseAdmin
      .from("panels")
      .select("id, page_number, bounding_box", { count: "exact" })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .order("page_number")
      .order("sort_order"),
    supabaseAdmin
      .from("pages")
      .select("number, width, height", { count: "exact" })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .order("number"),
    supabaseAdmin
      .from("characters")
      .select("id, display_name, aliases", { count: "exact" }),
    supabaseAdmin
      .from("voices")
      .select("id, display_name, status, character_id", { count: "exact" }),
    // The whole book's rows: a character cast in any issue is in the list.
    supabaseAdmin
      .from("castlist")
      .select("issue_id, character, character_id, voice_uuid", {
        count: "exact",
      })
      .eq("book_id", bookId),
  ]);
  const bubbleRows = rows<BubbleRow>("bubbles", bubbleResult);
  const panelRows = rows<PanelRow>("panels", panelResult);
  const pageRows = rows<PageRow>("pages", pageResult);
  const charRows = rows<CharacterRow>("characters", charResult);
  const voiceRows = rows<VoiceRow>("voices", voiceResult);
  const castRows = rows<CastRow>("the cast list", castResult)
    .slice()
    .sort(
      (a, b) => Number(b.issue_id === issueId) - Number(a.issue_id === issueId),
    );

  const dims = new Map(pageRows.map((p) => [p.number, p]));

  // Bubbles arrive in play order. `style` holds page percents; `box_2d` is page pixels.
  const bubbles: SrcBubble[] = bubbleRows.map((b) => {
    const d = dims.get(b.page_number) ?? DEFAULT_PAGE;
    const left = pct(b.style?.left);
    const top = pct(b.style?.top);
    const width = pct(b.style?.width);
    const height = pct(b.style?.height);
    const box = b.box_2d ?? {};
    const rect: Rect =
      left !== null && top !== null && width !== null && height !== null
        ? { x: left, y: top, w: width, h: height }
        : {
            x: clamp01((box.x ?? 0) / d.width),
            y: clamp01((box.y ?? 0) / d.height),
            w: clamp01((box.width ?? d.width * 0.1) / d.width),
            h: clamp01((box.height ?? d.height * 0.04) / d.height),
          };
    return {
      id: b.id,
      page: b.page_number,
      rect,
      text: b.ocr_text ?? "",
      textWithCues: b.text_with_cues,
      type: TYPES.includes(b.type) ? (b.type as BubbleType) : "SPEECH",
      speaker: b.speaker,
      emotion: b.emotion ?? "",
      ignored: b.ignored ?? false,
      silent: b.silent ?? false,
      confidence: typeof box.confidence === "number" ? box.confidence : null,
    };
  });

  const linked = new Map<string, string[]>();
  for (const b of bubbleRows) {
    if (b.panel_id)
      linked.set(b.panel_id, [...(linked.get(b.panel_id) ?? []), b.id]);
  }
  const panels: SrcPanel[] = panelRows.map((p) => ({
    id: p.id,
    page: p.page_number,
    rect: p.bounding_box,
    bubbleIds: linked.get(p.id) ?? [],
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
    const result = await supabaseAdmin
      .from("panel_character_detections")
      .select(
        "id, panel_id, character_id, identification_confidence, face_bbox",
        { count: "exact" },
      )
      .in("panel_id", ids);
    detectionRows.push(...rows<DetectionRow>("face detections", result));
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
      confidence: d.identification_confidence,
      rect: {
        x: panel.rect.x + (f.x ?? 0) * panel.rect.w,
        y: panel.rect.y + (f.y ?? 0) * panel.rect.h,
        w: (f.w ?? 0.1) * panel.rect.w,
        h: (f.h ?? 0.1) * panel.rect.h,
      },
    });
  }

  // A character's voice, always an active `voices` row picked by id
  // (decisions row 153). In order: this book's castlist `voice_uuid`, which is
  // the book's voice for the character (row 28), this issue's rows ahead of
  // the other issues'; then `voices.character_id`; a voice of the same name
  // only when neither says.
  const active = voiceRows.filter((v) => v.status === "active");
  const activeById = new Map(active.map((v) => [v.id, v]));
  const castVoice = new Map<string, VoiceRow>();
  for (const row of castRows) {
    const voice = row.voice_uuid ? activeById.get(row.voice_uuid) : undefined;
    if (!voice) continue;
    for (const key of [row.character_id, slug(row.character)]) {
      if (key && !castVoice.has(key)) castVoice.set(key, voice);
    }
  }
  const voiceByCharacter = new Map<string, VoiceRow>();
  const voiceByName = new Map<string, VoiceRow>();
  for (const v of active) {
    if (v.character_id && !voiceByCharacter.has(v.character_id))
      voiceByCharacter.set(v.character_id, v);
    const key = slug(v.display_name);
    if (key && !voiceByName.has(key)) voiceByName.set(key, v);
  }
  const voiceFor = (id: string, name: string): VoiceOption | null => {
    const voice =
      castVoice.get(id) ??
      castVoice.get(slug(name)) ??
      voiceByCharacter.get(id) ??
      voiceByName.get(id) ??
      voiceByName.get(slug(name));
    return voice ? { id: voice.id, name: voice.display_name } : null;
  };

  // A name means a `characters` row when it is the row's id, display name or alias.
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
  for (const row of castRows) ensure(row.character_id ?? row.character);
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
      portrait: null,
    });
  }

  const known: KnownCharacter[] = charRows.map((row) => {
    const name = row.display_name ?? titleCase(row.id);
    return {
      id: row.id,
      name,
      aliases: row.aliases ?? [],
      voice: voiceFor(row.id, name),
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
