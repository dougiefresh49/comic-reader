// Loads one issue for the characters stop: the proposed cast, every face, the exemplars and the voices. SELECTs only; the writes are in actions.ts.
import "server-only";
import { selectIssue } from "~/lib/issue-queries";
import { pageImageUrl } from "~/lib/storage";
import { DEFAULT_PAGE } from "~/app/api/apply-fixes/write-rules";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  isRoleId,
  loadBookCast,
  proposeCast,
  ROLE_IDS,
  voiceFor,
  type BookCast,
  type CastRow,
  type RoleId,
} from "~/lib/cast";
import { slugify } from "~/lib/character-id";
import {
  unknownFaceGroups,
  type UnknownDetection,
} from "~/server/admin/characters-gate";
import type {
  CharacterCard,
  CharactersData,
  FaceView,
  KnownCharacter,
  LooseExemplar,
  PageView,
  Rect,
  UnknownGroupView,
  VoiceView,
} from "./types";

interface IssueRow {
  name: string;
  number: number;
  books: { name: string; franchises: string[] | null } | null;
}

interface PageRow {
  number: number;
  width: number;
  height: number;
}

interface PanelRow {
  id: string;
  page_number: number;
  bounding_box: Rect | null;
}

interface DetectionRow extends UnknownDetection {
  panel_id: string;
  character_id: string | null;
  identification_confidence: number;
  human_verified: boolean;
  face_bbox: Partial<Rect> | null;
}

interface ExemplarRow {
  id: string;
  character_id: string | null;
  suggested_name: string | null;
  detection_id: string | null;
  page_number: number;
  crop_path: string;
  is_confirmed: boolean | null;
}

interface CharacterRow {
  id: string;
  display_name: string | null;
  aliases: string[] | null;
}

interface VoiceRow {
  id: string;
  display_name: string;
  character_id: string | null;
  status: string;
  created_at: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** The rows of one read, or a throw: a cut-short list would hide faces. */
function rows<T>(
  what: string,
  result: { data: unknown; error: unknown; count?: number | null },
): T[] {
  if (result.error) {
    console.error(`characters stop loader, ${what}:`, result.error);
    throw new Error(`The characters stop could not read ${what}.`);
  }
  const data = (result.data ?? []) as T[];
  if (typeof result.count === "number" && result.count > data.length) {
    throw new Error(
      `The characters stop read ${data.length} of ${result.count} ${what}.`,
    );
  }
  return data;
}

function exemplarUrl(cropPath: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/face-exemplars/${cropPath}`;
}

/** The issue's castlist rows for a character, matched as `cast.ts` matches: by id, else the null-id rows whose text resolves to it. */
function issueRowsFor(
  book: BookCast,
  issueRows: CastRow[],
  characterId: string,
): CastRow[] {
  const byId = issueRows.filter((r) => r.character_id === characterId);
  if (byId.length > 0) return byId;
  return issueRows.filter(
    (r) =>
      r.character_id === null &&
      (book.resolve(r.character)?.id ?? slugify(r.character)) === characterId,
  );
}

export async function loadCharacters(
  bookId: string,
  issueId: string,
): Promise<CharactersData | null> {
  const issueResult = await selectIssue(
    supabaseAdmin,
    bookId,
    issueId,
    "name, number, books(name, franchises)",
  ).maybeSingle();
  if (issueResult.error) {
    console.error("characters stop loader, the issue:", issueResult.error);
    throw new Error("The characters stop could not read the issue.");
  }
  const issue = issueResult.data as unknown as IssueRow | null;
  if (!issue) return null;

  const [
    book,
    proposal,
    pageResult,
    panelResult,
    exemplarResult,
    charResult,
    voiceResult,
  ] = await Promise.all([
    loadBookCast(supabaseAdmin, bookId),
    proposeCast(supabaseAdmin, bookId, issueId),
    supabaseAdmin
      .from("pages")
      .select("number, width, height", { count: "exact" })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .order("number"),
    supabaseAdmin
      .from("panels")
      .select("id, page_number, bounding_box", { count: "exact" })
      .eq("book_id", bookId)
      .eq("issue_id", issueId),
    // `source_issue` is this issue, so the seeded exemplars of #101
    // (`source_issue = 'seed'`) never reach this screen.
    supabaseAdmin
      .from("character_face_exemplars")
      .select(
        "id, character_id, suggested_name, detection_id, page_number, crop_path, is_confirmed",
        { count: "exact" },
      )
      .eq("book_id", bookId)
      .eq("source_issue", issueId)
      .order("page_number"),
    supabaseAdmin
      .from("characters")
      .select("id, display_name, aliases", { count: "exact" })
      .order("id"),
    supabaseAdmin
      .from("voices")
      .select("id, display_name, character_id, status, created_at", {
        count: "exact",
      }),
  ]);
  const pageRows = rows<PageRow>("pages", pageResult);
  const panelRows = rows<PanelRow>("panels", panelResult);
  const exemplarRows = rows<ExemplarRow>("face exemplars", exemplarResult);
  const charRows = rows<CharacterRow>("characters", charResult);
  const voiceRows = rows<VoiceRow>("voices", voiceResult);

  const detectionRows: DetectionRow[] = [];
  for (const ids of chunk(
    panelRows.map((p) => p.id),
    60,
  )) {
    const result = await supabaseAdmin
      .from("panel_character_detections")
      .select(
        "id, panel_id, character_id, cluster_id, suggested_name, identification_confidence, human_verified, face_bbox",
        { count: "exact" },
      )
      .in("panel_id", ids)
      .order("created_at");
    detectionRows.push(...rows<DetectionRow>("face detections", result));
  }

  // Pages: the `pages` rows, plus any page a panel mentions.
  const dims = new Map(pageRows.map((p) => [p.number, p]));
  const pageNumbers = new Set<number>(pageRows.map((p) => p.number));
  for (const p of panelRows) pageNumbers.add(p.page_number);
  const pages: PageView[] = [...pageNumbers]
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

  // Faces: a detection's box is panel-relative; the page box is what the screen draws.
  const panelById = new Map(panelRows.map((p) => [p.id, p]));
  const exemplarByDetection = new Map(
    exemplarRows
      .filter((e) => e.detection_id)
      .map((e) => [e.detection_id!, e] as const),
  );
  const faceOf = (d: DetectionRow): FaceView | null => {
    const panel = panelById.get(d.panel_id);
    if (!panel) return null;
    const box = panel.bounding_box ?? { x: 0, y: 0, w: 1, h: 1 };
    const f = d.face_bbox ?? {};
    const e = exemplarByDetection.get(d.id);
    return {
      id: d.id,
      page: panel.page_number,
      rect: {
        x: box.x + (f.x ?? 0) * box.w,
        y: box.y + (f.y ?? 0) * box.h,
        w: (f.w ?? 0.1) * box.w,
        h: (f.h ?? 0.1) * box.h,
      },
      confidence: d.identification_confidence,
      verified: d.human_verified,
      exemplar: e
        ? {
            id: e.id,
            confirmed: e.is_confirmed ?? false,
            cropUrl: exemplarUrl(e.crop_path),
          }
        : null,
    };
  };
  const byPage = (a: FaceView, b: FaceView) => a.page - b.page;
  const looseOf = (e: ExemplarRow): LooseExemplar => ({
    id: e.id,
    page: e.page_number,
    confirmed: e.is_confirmed ?? false,
    cropUrl: exemplarUrl(e.crop_path),
  });
  const loose = exemplarRows.filter((e) => !e.detection_id);

  // Group 1: the unknown face groups, as the gate groups them.
  const unnamed = detectionRows.filter((d) => d.character_id === null);
  const unknown: UnknownGroupView[] = unknownFaceGroups(unnamed).map((g) => {
    const names = new Set(g.suggestedNames.map(slugify));
    return {
      key: g.key,
      suggestedNames: g.suggestedNames,
      faces: g.detections
        .map(faceOf)
        .filter((f): f is FaceView => f !== null)
        .sort(byPage),
      looseExemplars: loose
        .filter(
          (e) =>
            e.character_id === null &&
            e.suggested_name &&
            names.has(slugify(e.suggested_name)),
        )
        .map(looseOf),
    };
  });
  unknown.sort(
    (a, b) =>
      b.faces.length - a.faces.length ||
      (a.faces[0]?.page ?? 0) - (b.faces[0]?.page ?? 0),
  );

  // The cast cards.
  const voiceName = new Map(voiceRows.map((v) => [v.id, v.display_name]));
  const displayName = (id: string) => book.resolve(id)?.display_name ?? id;
  // A member with no castlist row yet gets the voice `seedCast` will start it
  // with: its latest active `voices` row, so the card does not change on Approve.
  const startingVoice = new Map<string, string>();
  for (const v of voiceRows
    .filter((v) => v.status === "active" && v.character_id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (!startingVoice.has(v.character_id!))
      startingVoice.set(v.character_id!, v.display_name);
  }
  const voiceView = (id: string): VoiceView | null => {
    const v = voiceFor(book, id, issueId);
    if (!v) {
      const starting = startingVoice.get(id);
      return starting ? { name: starting, borrowedFrom: null } : null;
    }
    const name = (v.voiceUuid && voiceName.get(v.voiceUuid)) ?? v.voiceId;
    if (!name) return null;
    return { name, borrowedFrom: v.from === id ? null : displayName(v.from) };
  };
  const issueRows = book.rows.filter((r) => r.issue_id === issueId);
  const facesByCharacter = new Map<string, FaceView[]>();
  for (const d of detectionRows) {
    if (!d.character_id) continue;
    const f = faceOf(d);
    if (!f) continue;
    facesByCharacter.set(d.character_id, [
      ...(facesByCharacter.get(d.character_id) ?? []),
      f,
    ]);
  }

  const cards: CharacterCard[] = [];
  for (const m of proposal.members) {
    const mine = issueRowsFor(book, issueRows, m.id);
    const removed = mine.length > 0 && mine.every((r) => !r.in_issue);
    // In this issue: a face, a wiki mention, or a row in this issue's cast
    // (Add, or a seeded cast). Cast before: the rest of the book's cast.
    const group = isRoleId(m.id)
      ? "role"
      : m.sources.includes("faces") ||
          m.sources.includes("wiki") ||
          mine.some((r) => r.in_issue)
        ? "here"
        : "before";
    // A character cast before with no sign here and taken out of this issue
    // is not shown; the Add picker still offers it.
    if (group === "before" && removed) continue;
    cards.push({
      id: m.id,
      name: m.name,
      group,
      sources: m.sources,
      wikiNames: m.wikiNames,
      removed,
      faces: (facesByCharacter.get(m.id) ?? []).sort(byPage),
      looseExemplars: loose.filter((e) => e.character_id === m.id).map(looseOf),
      voice: voiceView(m.id),
    });
  }
  // Group order first, so the comparator is one consistent order; then names
  // A to Z, and the roles in their fixed order.
  const rank: Record<CharacterCard["group"], number> = {
    here: 0,
    before: 1,
    role: 2,
  };
  cards.sort((a, b) => {
    if (a.group !== b.group) return rank[a.group] - rank[b.group];
    if (a.group === "role")
      return (
        ROLE_IDS.indexOf(a.id as RoleId) - ROLE_IDS.indexOf(b.id as RoleId)
      );
    return a.name.localeCompare(b.name);
  });

  const known: KnownCharacter[] = charRows.map((c) => ({
    id: c.id,
    name: c.display_name ?? c.id,
    aliases: c.aliases ?? [],
  }));

  const inCast = cards.filter((c) => !c.removed).length;
  const faces = unnamed.length;
  const blocker =
    unknown.length > 0
      ? `${unknown.length} unknown face ${unknown.length === 1 ? "group" : "groups"} (${faces} ${faces === 1 ? "face" : "faces"}) still ${unknown.length === 1 ? "needs" : "need"} a name, or "Not a character".`
      : inCast === 0
        ? "The cast is empty: add at least one character."
        : null;

  return {
    bookId,
    issueId,
    bookName: issue.books?.name ?? bookId,
    issueName: issue.name?.trim() ? issue.name : `Issue ${issue.number}`,
    franchise: issue.books?.franchises?.[0] ?? null,
    pages,
    unknown,
    // Wiki names and castlist texts no `characters` row knows, as
    // `proposeCast` reports them: suggestions, never cards.
    suggestions: proposal.suggestions.map((s) => ({
      name: s.name,
      qualifier: s.qualifier,
      source: s.source,
    })),
    cards,
    known,
    blocker,
  };
}
