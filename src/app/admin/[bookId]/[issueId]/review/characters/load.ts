// Loads one issue for the characters stop: the proposed cast, every face, the exemplars and the voices. SELECTs only; the writes are in actions.ts.
import "server-only";
import { readAliases } from "~/lib/character-aliases";
import { selectIssue } from "~/lib/issue-queries";
import { pageImageUrl } from "~/lib/storage";
import { DEFAULT_PAGE } from "~/app/api/apply-fixes/write-rules";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  isRoleId,
  loadBookCast,
  proposeCast,
  readBookFranchises,
  readVoiceRequests,
  ROLE_IDS,
  voiceFor,
  castRow,
  isNoAudio,
  type RoleId,
} from "~/lib/cast";
import { slugify } from "~/lib/character-id";
import { chunk } from "~/lib/chunk";
import {
  clipObjectPath,
  readVoices,
  VOICE_CLIPS_BUCKET,
  type VoiceRow,
} from "~/lib/voice-slots";
import {
  unknownFaceGroups,
  type UnknownDetection,
} from "~/server/admin/characters-gate";
import type {
  ActiveVoice,
  CharacterCard,
  CharactersData,
  FaceView,
  KnownCharacter,
  LooseExemplar,
  PageView,
  Rect,
  Suggestion,
  UnknownGroupView,
  VoicePick,
  VoiceView,
} from "./types";

interface IssueRow {
  name: string;
  number: number;
  /** Slugs of the wiki names this issue's Needs a name section hides (#751). */
  dismissed_wiki_names: string[] | null;
  books: { name: string } | null;
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
}

interface AppearanceRow {
  id: string;
  character_id: string;
  work_id: string;
  voice_actor: string | null;
  works: { title: string; year: number } | null;
}

/** The picker's voice statuses, in list order. */
const PICK_RANK = { active: 0, archived: 1, needs_clip: 2 } as const;
type PickStatus = keyof typeof PICK_RANK;

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

/** A signed URL to a lab clip, or null: a clip that will not sign loses its play button, never the page. */
async function signedClipUrl(sourceClipPath: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.storage
      .from(VOICE_CLIPS_BUCKET)
      .createSignedUrl(clipObjectPath(sourceClipPath), 3600);
    if (error || !data) {
      console.warn(
        `characters stop loader, signing ${sourceClipPath}:`,
        error?.message,
      );
      return null;
    }
    return data.signedUrl;
  } catch (err) {
    console.warn(`characters stop loader, signing ${sourceClipPath}:`, err);
    return null;
  }
}

function exemplarUrl(cropPath: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/face-exemplars/${cropPath}`;
}

export async function loadCharacters(
  bookId: string,
  issueId: string,
): Promise<CharactersData | null> {
  const issueResult = await selectIssue(
    supabaseAdmin,
    bookId,
    issueId,
    "name, number, dismissed_wiki_names, books(name)",
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
    voiceRows,
    voiceRequests,
    franchises,
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
      .select("id, display_name", { count: "exact" })
      .order("id"),
    readVoices(supabaseAdmin),
    readVoiceRequests(supabaseAdmin, bookId, issueId),
    readBookFranchises(supabaseAdmin, bookId),
  ]);
  const pageRows = rows<PageRow>("pages", pageResult);
  const panelRows = rows<PanelRow>("panels", panelResult);
  const exemplarRows = rows<ExemplarRow>("face exemplars", exemplarResult);
  const charRows = rows<CharacterRow>("characters", charResult);
  const aliasesOf = await readAliases(
    supabaseAdmin,
    charRows.map((c) => c.id),
    bookId,
  );

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
  const startingVoice = new Map<string, VoiceRow>();
  for (const v of voiceRows
    .filter((v) => v.status === "active" && v.character_id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (!startingVoice.has(v.character_id!))
      startingVoice.set(v.character_id!, v);
  }
  const voiceView = (id: string): VoiceView | null => {
    // A "no audio" row is silent: no voice of its own, and no fallback (#410).
    if (isNoAudio(book, id, issueId)) return null;
    // A removed member's card still shows the voice it would come back with.
    const removed = castRow(book, id, issueId)?.in_issue === false;
    const v = voiceFor(book, id, removed ? undefined : issueId);
    if (!v) {
      const starting = startingVoice.get(id);
      return starting
        ? { name: starting.display_name, borrowedFrom: null, uuid: starting.id }
        : null;
    }
    const name = voiceName.get(v.voiceUuid) ?? v.elevenLabsId;
    if (!name) return null;
    return {
      name,
      borrowedFrom: v.from === id ? null : displayName(v.from),
      uuid: v.voiceUuid,
    };
  };

  // The picker's voices (#458): every active, archived and needs_clip row
  // of the character. An archived one a castlist row of this book links is
  // marked `inBook`: choosing it casts it for this issue and the voices stop
  // restores it, where an unlinked one is a new clone request (#350). Within
  // a status, the starting pick first, then by name.
  const linkedInBook = new Set(
    book.rows.map((r) => r.voice_uuid).filter((u): u is string => !!u),
  );
  const pickRowsOf = new Map<string, (VoiceRow & { status: PickStatus })[]>();
  for (const v of voiceRows) {
    if (!v.character_id || !(v.status in PICK_RANK)) continue;
    pickRowsOf.set(v.character_id, [
      ...(pickRowsOf.get(v.character_id) ?? []),
      v as VoiceRow & { status: PickStatus },
    ]);
  }
  for (const list of pickRowsOf.values())
    list.sort(
      (a, b) =>
        PICK_RANK[a.status] - PICK_RANK[b.status] ||
        Number(b.starting_pick) - Number(a.starting_pick) ||
        a.display_name.localeCompare(b.display_name),
    );
  /** Appearances some `voices` row holds; the picker lists the rest. */
  const heldAppearances = new Set(
    voiceRows.map((v) => v.appearance_id).filter((a): a is string => !!a),
  );
  const pendingRequest = new Map(
    voiceRequests
      .filter((r) => r.status === "pending")
      .map((r) => [r.characterId, r] as const),
  );
  const characterIds = new Set(charRows.map((c) => c.id));
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
    const mine = castRow(book, m.id, issueId);
    const removed = mine?.in_issue === false;
    // In this issue: a face, a wiki mention, or a row in this issue's cast
    // (Add, or a seeded cast). Cast before: the rest of the book's cast.
    const group = isRoleId(m.id)
      ? "role"
      : m.sources.includes("faces") ||
          m.sources.includes("wiki") ||
          mine?.in_issue === true
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
      noAudio: mine?.no_audio === true,
      faces: (facesByCharacter.get(m.id) ?? []).sort(byPage),
      looseExemplars: loose.filter((e) => e.character_id === m.id).map(looseOf),
      voice: voiceView(m.id),
      voicePicks: [],
      voiceRequest: null,
    });
  }

  // The appearances of the cards that show the Change control, and of any
  // voice of theirs whose appearance is filed under another character.
  const pickerIds = cards
    .filter((c) => characterIds.has(c.id) && !c.removed)
    .map((c) => c.id);
  const appearanceRows: AppearanceRow[] = [];
  const readAppearances = async (
    column: "character_id" | "id",
    ids: string[],
  ) => {
    for (const part of chunk(ids, 100)) {
      const result = await supabaseAdmin
        .from("appearances")
        .select("id, character_id, work_id, voice_actor, works(title, year)", {
          count: "exact",
        })
        .in(column, part);
      appearanceRows.push(...rows<AppearanceRow>("appearances", result));
    }
  };
  await readAppearances("character_id", pickerIds);
  const readIds = new Set(appearanceRows.map((a) => a.id));
  await readAppearances("id", [
    ...new Set(
      pickerIds.flatMap((id) =>
        (pickRowsOf.get(id) ?? []).flatMap((v) =>
          v.appearance_id && !readIds.has(v.appearance_id)
            ? [v.appearance_id]
            : [],
        ),
      ),
    ),
  ]);
  const workOf = new Map(
    appearanceRows.map((a) => [
      a.id,
      a.works ? `${a.works.title} (${a.works.year})` : a.work_id,
    ]),
  );

  // The Change control's data, only on cards that are a `characters` row.
  // Clips are signed only for cards that show the control (not removed).
  await Promise.all(
    cards.map(async (card) => {
      if (!characterIds.has(card.id)) return;
      const request = pendingRequest.get(card.id);
      if (request) {
        const target = request.targetVoiceUuid;
        card.voiceRequest = {
          action: request.action,
          targetName:
            request.action === "clone" && target
              ? (voiceName.get(target) ?? target)
              : null,
        };
      }
      if (card.removed) return;
      const voices = await Promise.all(
        (pickRowsOf.get(card.id) ?? []).map(
          async (v): Promise<VoicePick> => ({
            kind: "voice",
            id: v.id,
            name: v.display_name,
            status: v.status,
            inBook: linkedInBook.has(v.id),
            work: v.appearance_id
              ? (workOf.get(v.appearance_id) ?? null)
              : null,
            appearanceId: v.appearance_id,
            startingPick: v.starting_pick,
            clipUrl:
              v.status === "archived" && v.source_clip_path
                ? await signedClipUrl(v.source_clip_path)
                : null,
          }),
        ),
      );
      const appearances: VoicePick[] = appearanceRows
        .filter((a) => a.character_id === card.id && !heldAppearances.has(a.id))
        .map((a) => ({
          kind: "appearance" as const,
          id: a.id,
          work: workOf.get(a.id) ?? a.work_id,
          voiceActor: a.voice_actor,
        }))
        .sort((a, b) => a.work.localeCompare(b.work));
      card.voicePicks = [...voices, ...appearances];
    }),
  );
  const activeVoices: ActiveVoice[] = voiceRows
    .filter((v) => v.status === "active")
    .map((v) => ({ id: v.id, name: v.display_name }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
    aliases: aliasesOf.get(c.id) ?? [],
  }));

  // A wiki name dismissed for this issue (#751) is hidden, never a blocker.
  const dismissedSlugs = new Set(issue.dismissed_wiki_names ?? []);
  const suggestions: Suggestion[] = [];
  const dismissed: Suggestion[] = [];
  for (const s of proposal.suggestions) {
    const view: Suggestion = {
      name: s.name,
      qualifier: s.qualifier,
      source: s.source,
    };
    if (s.source === "wiki" && dismissedSlugs.has(slugify(s.name)))
      dismissed.push(view);
    else suggestions.push(view);
  }

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
    // A character created here takes the book's lowest-position franchise.
    franchiseId: franchises[0]?.id ?? null,
    pages,
    unknown,
    // Wiki names and castlist texts no `characters` row knows, as
    // `proposeCast` reports them: suggestions, never cards.
    suggestions,
    dismissed,
    cards,
    known,
    activeVoices,
    blocker,
  };
}
