// Loads one issue for the review editor: pages, panels, bubbles, face detections and the cast. SELECTs only.
import "server-only";
import { selectIssue } from "~/lib/issue-queries";
import { pageImageUrl } from "~/lib/storage";
import { DEFAULT_PAGE } from "~/app/api/apply-fixes/write-rules";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  getCast,
  isRoleId,
  loadBookCast,
  proposeCast,
  ROLE_IDS,
  voiceFor,
  type CastVoice,
} from "~/lib/cast";
import { NARRATOR_ID, titleCase } from "~/components/review-editor/lib";
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
import { readVoices, type VoiceRow } from "~/lib/voice-slots";
import { VOICE_SLOTS_TOTAL } from "~/lib/voice-slots/types";

interface IssueRow {
  name: string;
  pipeline_step: string | null;
  pipeline_paused: boolean | null;
  books: { name: string } | null;
}

interface PageRow {
  number: number;
  width: number;
  height: number;
  reviewed_at: string | null;
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
  kept: boolean | null;
  audio_storage_path: string | null;
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

export async function loadEditor(
  bookId: string,
  issueId: string,
): Promise<EditorData | null> {
  const issueResult = await selectIssue(
    supabaseAdmin,
    bookId,
    issueId,
    "name, pipeline_step, pipeline_paused, books(name)",
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
    voiceRows,
    castEntries,
    book,
  ] = await Promise.all([
    supabaseAdmin
      .from("bubbles")
      .select(
        "id, page_number, panel_id, ocr_text, text_with_cues, type, speaker, emotion, ignored, silent, kept, audio_storage_path, box_2d, style",
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
      .select("number, width, height, reviewed_at", { count: "exact" })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .order("number"),
    supabaseAdmin
      .from("characters")
      .select("id, display_name, aliases", { count: "exact" }),
    // Throws on a failed read, which fails the page like `rows` does.
    readVoices(supabaseAdmin),
    getCast(supabaseAdmin, bookId, issueId),
    loadBookCast(supabaseAdmin, bookId),
  ]);
  const bubbleRows = rows<BubbleRow>("bubbles", bubbleResult);
  const panelRows = rows<PanelRow>("panels", panelResult);
  const pageRows = rows<PageRow>("pages", pageResult);
  const charRows = rows<CharacterRow>("characters", charResult);

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
      kept: b.kept ?? false,
      confidence: typeof box.confidence === "number" ? box.confidence : null,
      audioPath: b.audio_storage_path,
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
        reviewedAt: dims.get(number)?.reviewed_at ?? null,
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
  // (decisions row 153), never by its name (#458). In order: the cast's
  // voice (`voiceFor` in `~/lib/cast`), then `voices.character_id`.
  const active = voiceRows.filter((v) => v.status === "active");
  const activeById = new Map(active.map((v) => [v.id, v]));
  const activeByElevenLabs = new Map<string, VoiceRow>();
  const voiceByCharacter = new Map<string, VoiceRow>();
  for (const v of active) {
    const el = v.current_elevenlabs_id;
    if (el && !activeByElevenLabs.has(el)) activeByElevenLabs.set(el, v);
    if (v.character_id && !voiceByCharacter.has(v.character_id))
      voiceByCharacter.set(v.character_id, v);
  }
  const voiceOption = (
    id: string,
    castVoice: CastVoice | null,
  ): VoiceOption | null => {
    const voice =
      (castVoice?.voiceUuid
        ? activeById.get(castVoice.voiceUuid)
        : undefined) ??
      (castVoice?.elevenLabsId
        ? activeByElevenLabs.get(castVoice.elevenLabsId)
        : undefined) ??
      voiceByCharacter.get(id);
    return voice ? { id: voice.id, name: voice.display_name } : null;
  };

  // The speaker list is the issue's cast (#355). An issue with no castlist
  // rows at all gets the proposed cast, in memory only; nothing is written
  // here. Rows with `in_issue` false are removals and stay out; a row with
  // no `character_id` is held at the characters stop and is not listed.
  const issueRows = book.rows.filter((r) => r.issue_id === issueId);
  const removed = new Set(
    issueRows.flatMap((r) =>
      !r.in_issue && r.character_id ? [r.character_id] : [],
    ),
  );
  const listed: { id: string; voice: CastVoice | null; label: string }[] =
    issueRows.length > 0
      ? castEntries.flatMap((e) =>
          e.characterId
            ? [{ id: e.characterId, voice: e.voice, label: e.character }]
            : [],
        )
      : (await proposeCast(supabaseAdmin, bookId, issueId)).members.map(
          (m) => ({
            id: m.id,
            voice: voiceFor(book, m.id, issueId),
            label: m.name,
          }),
        );
  // A role is offered unless the cast removed it.
  for (const id of ROLE_IDS) {
    if (listed.some((l) => l.id === id)) continue;
    // Narrator always stays: model.ts assigns narration bubbles to it.
    if (removed.has(id) && id !== NARRATOR_ID) continue;
    listed.push({ id, voice: voiceFor(book, id, issueId), label: id });
  }

  const facesOf = new Map<string, Face[]>();
  for (const f of faces)
    if (f.characterId)
      facesOf.set(f.characterId, [...(facesOf.get(f.characterId) ?? []), f]);
  const pageAspect = (n: number) => {
    const d = dims.get(n) ?? DEFAULT_PAGE;
    return d.width / d.height;
  };
  const characters: CastMember[] = [];
  const roles = new Map<string, CastMember>();
  for (const { id, voice, label } of listed) {
    if (roles.has(id) || characters.some((c) => c.id === id)) continue;
    const row = book.resolve(id);
    const own = row?.id === id ? row : undefined;
    const name =
      own?.display_name ?? (label === id ? titleCase(id) : label.trim());
    const member: CastMember = {
      id,
      name,
      aliases: own?.aliases ?? [],
      kind: isRoleId(id) ? "role" : "character",
      tint: 0,
      voice: voiceOption(id, voice),
      portrait: null,
    };
    if (isRoleId(id)) {
      roles.set(id, member);
      continue;
    }
    // The portrait is the most face-like box: close to square, not panel-sized.
    const best = (facesOf.get(id) ?? [])
      .map((f) => {
        const squareness = Math.abs(
          Math.log((f.rect.w * pageAspect(f.page)) / f.rect.h),
        );
        return { f, score: f.confidence - squareness - f.rect.h * 2 };
      })
      .sort((a, b) => b.score - a.score)[0];
    if (best) member.portrait = { page: best.f.page, rect: best.f.rect };
    characters.push(member);
  }
  characters.sort((a, b) => a.name.localeCompare(b.name));
  characters.forEach((member, i) => (member.tint = i));
  const members: CastMember[] = [
    ...characters,
    ...ROLE_IDS.flatMap((id) => roles.get(id) ?? []),
  ];

  const known: KnownCharacter[] = charRows.map((row) => {
    const name = row.display_name ?? titleCase(row.id);
    return {
      id: row.id,
      name,
      aliases: row.aliases ?? [],
      voice: voiceOption(row.id, voiceFor(book, row.id, issueId)),
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
    slotsTotal: VOICE_SLOTS_TOTAL,
    atPagesGate:
      issue.pipeline_step === "review-pages" && issue.pipeline_paused === true,
  };
}
