// The editor's document: plain data plus pure operations, so undo is a stack of snapshots.
import { DEFAULT_GROUP_GAP_PX, scanBalloonPairs } from "~/lib/balloon-groups";
import { NARRATOR_ID, slug } from "./lib";
import { SPOKEN, needsSpeaker } from "~/lib/bubble-types";
import type {
  BubbleType,
  CastMember,
  EditorData,
  Face,
  Rect,
  SrcBubble,
} from "./types";

export { SPOKEN, needsSpeaker };

export interface BubbleDoc {
  id: string;
  page: number;
  rect: Rect;
  text: string;
  /**
   * The row's `text_with_cues` and the text it was written for, kept so a
   * deleted row that comes back (an undo after a Save) goes back in whole.
   */
  cues: { forText: string; value: string } | null;
  type: BubbleType;
  /** A cast id from the closed list, or null. Loaded from `bubbles.character_id`. */
  speakerId: string | null;
  /** The stored `speaker` label while the bubble has no cast id: shown, flagged, never matched to the cast. */
  rawSpeaker: string | null;
  emotion: string;
  silent: boolean;
  ignored: boolean;
  /**
   * Deleted by the owner, or dismissed as a duplicate detection. The row
   * stays in its list so the tree can offer to restore it.
   */
  deleted: boolean;
  /** The owner said this overlap is not a duplicate. */
  kept: boolean;
  /** Drawn in the browser and never reordered by hand: it re-sorts as its box moves. */
  auto: boolean;
  confidence: number | null;
  /**
   * `bubbles.group_id` (#451): shared with another bubble = joined balloons;
   * held alone = reviewed, stands alone; null = not reviewed yet.
   */
  groupId: string | null;
}

export interface PanelDoc {
  id: string;
  page: number;
  rect: Rect;
  bubbleIds: string[];
}

export interface PageDoc {
  number: number;
  /** The page image's size in pixels, for the joined-balloon gap (#451). */
  width: number;
  height: number;
  panelIds: string[];
  /** Bubbles that overlap no panel. */
  looseIds: string[];
}

/**
 * A character added to the cast in the editor (#416), held until Save. The
 * id is the `characters.id` it is expected to have; Save decides whether the
 * name is new (`planCastAdds`). It starts with the voice the Characters
 * screen would give it; the editor sets no voice.
 */
export interface AddedCast {
  id: string;
  name: string;
}

export interface Doc {
  bubbles: Record<string, BubbleDoc>;
  panels: Record<string, PanelDoc>;
  pages: Record<number, PageDoc>;
  addedCast: AddedCast[];
}

export interface Sel {
  kind: "bubble" | "panel";
  id: string;
}

export type Flag =
  | { kind: "no-speaker" }
  | { kind: "unknown-speaker"; raw: string }
  | { kind: "duplicate"; ofId: string }
  /**
   * Touches a balloon of another speaker (#451): maybe one line split in
   * two. A prompt, not a defect: it never blocks approval and is left out of
   * `issueFlags`.
   */
  | { kind: "touching"; ofId: string };

/** A flag that asks a question rather than marks something wrong. */
export function isPrompt(
  flag: Flag,
): flag is Extract<Flag, { kind: "touching" }> {
  return flag.kind === "touching";
}

/** The page's live bubbles that keep it from being approved, in play order. */
export function unvoicedBubbles(doc: Doc, pageNumber: number): BubbleDoc[] {
  return visibleBubbles(doc, pageBubbleIds(doc, pageNumber)).filter((b) =>
    needsSpeaker({ ...b, speaker: b.speakerId ?? b.rawSpeaker }),
  );
}

// ---------------------------------------------------------------- geometry

export function area(r: Rect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

export function intersection(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function clampRect(r: Rect): Rect {
  const w = Math.min(1, Math.max(0.008, r.w));
  const h = Math.min(1, Math.max(0.006, r.h));
  return {
    x: Math.min(1 - w, Math.max(0, r.x)),
    y: Math.min(1 - h, Math.max(0, r.y)),
    w,
    h,
  };
}

/**
 * The panel a box overlaps most, or null when it touches none. On a tie (a
 * box wholly inside two panels) the smaller panel wins, so an inset panel
 * keeps the bubbles drawn inside it.
 */
export function bestPanel(rect: Rect, panels: PanelDoc[]): string | null {
  const EPSILON = 1e-9;
  let best: PanelDoc | null = null;
  let bestArea = 0;
  for (const p of panels) {
    const a = intersection(rect, p.rect);
    if (a <= EPSILON) continue;
    const tie = best !== null && Math.abs(a - bestArea) <= EPSILON;
    if (tie ? area(p.rect) < area(best?.rect ?? p.rect) : a > bestArea) {
      bestArea = a;
      best = p;
    }
  }
  return best?.id ?? null;
}

/**
 * The faces whose centre sits inside a panel's box as it is now, so a drawn
 * or resized panel offers the faces it covers.
 */
export function facesIn(faces: Face[], panel: PanelDoc): Face[] {
  const { x, y, w, h } = panel.rect;
  return faces.filter((f) => {
    const cx = f.rect.x + f.rect.w / 2;
    const cy = f.rect.y + f.rect.h / 2;
    return (
      f.page === panel.page && cx >= x && cx <= x + w && cy >= y && cy <= y + h
    );
  });
}

/** Reading order by top-left corner: same row reads left to right. */
export function comesBefore(a: Rect, b: Rect): boolean {
  const tolerance = Math.min(a.h, b.h) * 0.5;
  if (Math.abs(a.y - b.y) <= tolerance) return a.x < b.x;
  return a.y < b.y;
}

// ------------------------------------------------------------------- init

/**
 * The row as the editor holds it. `character_id` decides the speaker (rule
 * R5): a null id is unassigned and flagged, even when its label reads like a
 * cast member, and an id the issue's cast does not hold is shown the same
 * way, by its label.
 */
function toBubble(src: SrcBubble, cast: CastMember[]): BubbleDoc {
  const speakerId =
    src.characterId && cast.some((c) => c.id === src.characterId)
      ? src.characterId
      : null;
  return {
    id: src.id,
    page: src.page,
    rect: src.rect,
    text: src.text,
    cues:
      src.textWithCues !== null
        ? { forText: src.text, value: src.textWithCues }
        : null,
    type: src.type,
    speakerId,
    rawSpeaker: speakerId ? null : src.speaker,
    emotion: src.emotion,
    silent: src.silent,
    ignored: src.ignored,
    deleted: false,
    kept: src.kept,
    auto: false,
    confidence: src.confidence,
    groupId: src.groupId,
  };
}

export function initDoc(data: EditorData): Doc {
  const doc: Doc = { bubbles: {}, panels: {}, pages: {}, addedCast: [] };
  for (const page of data.pages) {
    doc.pages[page.number] = {
      number: page.number,
      width: page.width,
      height: page.height,
      panelIds: [],
      looseIds: [],
    };
  }
  const linked = new Map<string, string>();
  for (const p of data.panels) {
    doc.panels[p.id] = { id: p.id, page: p.page, rect: p.rect, bubbleIds: [] };
    doc.pages[p.page]?.panelIds.push(p.id);
    for (const id of p.bubbleIds) linked.set(id, p.id);
  }
  // Rows arrive in play order, so appending keeps that order inside each panel.
  // A bubble with no `panel_id` goes to the panel its box overlaps most.
  for (const src of data.bubbles) {
    const page = doc.pages[src.page];
    if (!page) continue;
    const bubble = toBubble(src, data.cast);
    doc.bubbles[bubble.id] = bubble;
    const panels = page.panelIds.flatMap((id) => doc.panels[id] ?? []);
    const panelId = linked.get(src.id) ?? bestPanel(src.rect, panels);
    const panel = panelId ? doc.panels[panelId] : undefined;
    if (panel) panel.bubbleIds.push(bubble.id);
    else page.looseIds.push(bubble.id);
  }
  return doc;
}

// ---------------------------------------------------------------- queries

export function pagePanels(doc: Doc, pageNumber: number): PanelDoc[] {
  return (doc.pages[pageNumber]?.panelIds ?? []).flatMap(
    (id) => doc.panels[id] ?? [],
  );
}

/** Every bubble id of a page in play order, deleted ones included. */
export function pageBubbleIds(doc: Doc, pageNumber: number): string[] {
  const page = doc.pages[pageNumber];
  if (!page) return [];
  return [
    ...pagePanels(doc, pageNumber).flatMap((p) => p.bubbleIds),
    ...page.looseIds,
  ];
}

export function visibleBubbles(doc: Doc, ids: string[]): BubbleDoc[] {
  return ids.flatMap((id) => {
    const b = doc.bubbles[id];
    return b && !b.deleted ? [b] : [];
  });
}

export function panelOf(doc: Doc, bubble: BubbleDoc): PanelDoc | null {
  for (const p of pagePanels(doc, bubble.page)) {
    if (p.bubbleIds.includes(bubble.id)) return p;
  }
  return null;
}

/** Flags for one page: the bubbles that need the owner, and why. */
export function pageFlags(doc: Doc, pageNumber: number): Map<string, Flag[]> {
  const out = new Map<string, Flag[]>();
  const add = (id: string, flag: Flag) =>
    out.set(id, [...(out.get(id) ?? []), flag]);
  const live = visibleBubbles(doc, pageBubbleIds(doc, pageNumber)).filter(
    (b) => !b.ignored,
  );

  for (const b of live) {
    if (!SPOKEN.includes(b.type) || b.silent || b.speakerId) continue;
    if (b.rawSpeaker) add(b.id, { kind: "unknown-speaker", raw: b.rawSpeaker });
    else add(b.id, { kind: "no-speaker" });
  }

  // A duplicate detection is a box that swallows another balloon's box, or a
  // near-identical twin with the lower confidence.
  live.forEach((a, ai) => {
    if (a.kept) return;
    for (let bi = 0; bi < live.length; bi++) {
      const b = live[bi];
      if (!b || bi === ai) continue;
      const inter = intersection(a.rect, b.rect);
      if (inter === 0) continue;
      const areaA = area(a.rect);
      const areaB = area(b.rect);
      const iou = inter / (areaA + areaB - inter);
      const swallows = inter / areaB >= 0.7 && areaA >= areaB * 1.2;
      const ca = a.confidence ?? 0;
      const cb = b.confidence ?? 0;
      const losingTwin = iou >= 0.6 && (ca < cb || (ca === cb && ai > bi));
      if (swallows || losingTwin) {
        add(a.id, { kind: "duplicate", ofId: b.id });
        return;
      }
    }
  });

  // Two speakers' balloons touching in play order, neither reviewed for
  // joining yet (#451): the finder's `disagreeing` pairs.
  const page = doc.pages[pageNumber];
  if (page) {
    const panelOfId = new Map<string, string>();
    for (const p of pagePanels(doc, pageNumber))
      for (const id of p.bubbleIds) panelOfId.set(id, p.id);
    const { disagreeing } = scanBalloonPairs(
      live.map((b, i) => ({
        id: b.id,
        panelId: panelOfId.get(b.id) ?? null,
        sortOrder: i,
        characterId: b.speakerId,
        type: b.type,
        ignored: b.ignored,
        box: {
          x: b.rect.x * page.width,
          y: b.rect.y * page.height,
          width: b.rect.w * page.width,
          height: b.rect.h * page.height,
        },
      })),
      DEFAULT_GROUP_GAP_PX,
    );
    // The prompt stands while nobody has ruled on the pair: neither balloon
    // is in a shared group, and at least one has no `groupId` yet (a
    // "Not one line" on a neighbouring pair marks only the balloon it names).
    const holders = new Map<string, number>();
    for (const b of visibleBubbles(doc, pageBubbleIds(doc, pageNumber)))
      if (b.groupId) holders.set(b.groupId, (holders.get(b.groupId) ?? 0) + 1);
    const shared = (id: string) => {
      const g = doc.bubbles[id]?.groupId;
      return !!g && (holders.get(g) ?? 0) >= 2;
    };
    for (const [a, b] of disagreeing) {
      if (shared(a) || shared(b)) continue;
      if (doc.bubbles[a]?.groupId && doc.bubbles[b]?.groupId) continue;
      add(a, { kind: "touching", ofId: b });
      add(b, { kind: "touching", ofId: a });
    }
  }
  return out;
}

/** The flags that mark something wrong: `pageFlags` without the prompts. */
export function defectFlags(flags: Map<string, Flag[]>): Map<string, Flag[]> {
  const out = new Map<string, Flag[]>();
  for (const [id, list] of flags) {
    const defects = list.filter((f) => !isPrompt(f));
    if (defects.length > 0) out.set(id, defects);
  }
  return out;
}

/** Each bubble's touching-balloon prompt (#451): the other balloon's id. */
export function touchingFlags(flags: Map<string, Flag[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, list] of flags) {
    const touching = list.find(isPrompt);
    if (touching) out.set(id, touching.ofId);
  }
  return out;
}

export interface IssueFlag {
  page: number;
  bubbleId: string;
  flags: Flag[];
}

/** Every flagged bubble of the issue, in page then play order. */
export function issueFlags(doc: Doc): IssueFlag[] {
  const out: IssueFlag[] = [];
  const numbers = Object.values(doc.pages)
    .map((p) => p.number)
    .sort((a, b) => a - b);
  for (const n of numbers) {
    const flags = defectFlags(pageFlags(doc, n));
    for (const id of pageBubbleIds(doc, n)) {
      const f = flags.get(id);
      if (f) out.push({ page: n, bubbleId: id, flags: f });
    }
  }
  return out;
}

// -------------------------------------------------------------- operations

function withBubble(doc: Doc, id: string, patch: Partial<BubbleDoc>): Doc {
  const b = doc.bubbles[id];
  if (!b) return doc;
  return { ...doc, bubbles: { ...doc.bubbles, [id]: { ...b, ...patch } } };
}

export function patchBubble(
  doc: Doc,
  id: string,
  patch: Partial<BubbleDoc>,
): Doc {
  // A bubble with no speaker yet that becomes narration is the Narrator's.
  const b = doc.bubbles[id];
  if (patch.type === "NARRATION" && b && !b.speakerId && !b.rawSpeaker) {
    return withBubble(doc, id, { ...patch, speakerId: NARRATOR_ID });
  }
  return withBubble(doc, id, patch);
}

/**
 * A joined group has one speaker (#451), so a speaker set on any member is
 * set on every member.
 */
export function setSpeaker(doc: Doc, id: string, castId: string | null): Doc {
  const members = groupMembers(doc, id);
  let next = doc;
  for (const target of members.length > 0 ? members.map((m) => m.id) : [id])
    next = withBubble(next, target, { speakerId: castId, rawSpeaker: null });
  return next;
}

/** Take a bubble out of whichever list holds it. */
function detach(doc: Doc, bubble: BubbleDoc): Doc {
  const page = doc.pages[bubble.page];
  if (!page) return doc;
  const panels = { ...doc.panels };
  for (const id of page.panelIds) {
    const p = panels[id];
    if (p?.bubbleIds.includes(bubble.id)) {
      panels[id] = {
        ...p,
        bubbleIds: p.bubbleIds.filter((b) => b !== bubble.id),
      };
    }
  }
  return {
    ...doc,
    panels,
    pages: {
      ...doc.pages,
      [page.number]: {
        ...page,
        looseIds: page.looseIds.filter((b) => b !== bubble.id),
      },
    },
  };
}

function attach(
  doc: Doc,
  bubble: BubbleDoc,
  panelId: string | null,
  index: number,
): Doc {
  if (panelId) {
    const panel = doc.panels[panelId];
    if (!panel) return doc;
    const ids = panel.bubbleIds.slice();
    ids.splice(Math.max(0, Math.min(index, ids.length)), 0, bubble.id);
    return {
      ...doc,
      panels: { ...doc.panels, [panelId]: { ...panel, bubbleIds: ids } },
    };
  }
  const page = doc.pages[bubble.page];
  if (!page) return doc;
  const ids = page.looseIds.slice();
  ids.splice(Math.max(0, Math.min(index, ids.length)), 0, bubble.id);
  return {
    ...doc,
    pages: { ...doc.pages, [page.number]: { ...page, looseIds: ids } },
  };
}

/** Where a box belongs among a panel's bubbles, by its top-left corner. */
function indexByCorner(doc: Doc, ids: string[], rect: Rect): number {
  for (let i = 0; i < ids.length; i++) {
    const other = doc.bubbles[ids[i] ?? ""];
    if (!other || other.deleted) continue;
    if (comesBefore(rect, other.rect)) return i;
  }
  return ids.length;
}

/** Put a bubble in the panel it overlaps most, in position by its corner. */
function placeByBox(doc: Doc, id: string): Doc {
  const bubble = doc.bubbles[id];
  if (!bubble) return doc;
  const cleared = detach(doc, bubble);
  const panelId = bestPanel(bubble.rect, pagePanels(cleared, bubble.page));
  const siblings = panelId
    ? (cleared.panels[panelId]?.bubbleIds ?? [])
    : (cleared.pages[bubble.page]?.looseIds ?? []);
  return attach(
    cleared,
    bubble,
    panelId,
    indexByCorner(cleared, siblings, bubble.rect),
  );
}

export function moveBubbleTo(
  doc: Doc,
  id: string,
  panelId: string | null,
  index: number,
): Doc {
  const bubble = doc.bubbles[id];
  if (!bubble) return doc;
  const next = attach(detach(doc, bubble), bubble, panelId, index);
  return withBubble(next, id, { auto: false });
}

/** Move a bubble to another panel, landing where its box says it reads. */
export function moveBubbleToPanel(
  doc: Doc,
  id: string,
  panelId: string | null,
): Doc {
  const bubble = doc.bubbles[id];
  if (!bubble) return doc;
  const cleared = detach(doc, bubble);
  const siblings = panelId
    ? (cleared.panels[panelId]?.bubbleIds ?? [])
    : (cleared.pages[bubble.page]?.looseIds ?? []);
  const next = attach(
    cleared,
    bubble,
    panelId,
    indexByCorner(cleared, siblings, bubble.rect),
  );
  return withBubble(next, id, { auto: false });
}

/** One step earlier or later in play order, crossing into the next panel at the ends. */
export function shiftBubble(doc: Doc, id: string, dir: -1 | 1): Doc {
  const bubble = doc.bubbles[id];
  const page = bubble ? doc.pages[bubble.page] : undefined;
  if (!bubble || !page) return doc;
  const panel = panelOf(doc, bubble);
  const ids = panel ? panel.bubbleIds : page.looseIds;
  const at = ids.indexOf(id);
  // Step over deleted rows so one press is one visible move.
  let to = at + dir;
  while (to >= 0 && to < ids.length && doc.bubbles[ids[to] ?? ""]?.deleted)
    to += dir;
  if (to >= 0 && to < ids.length) {
    return moveBubbleTo(doc, id, panel?.id ?? null, to);
  }
  const containers: (string | null)[] = [...page.panelIds];
  if (page.looseIds.length > 0 || !panel) containers.push(null);
  const ci = containers.indexOf(panel?.id ?? null);
  const target = containers[ci + dir];
  if (target === undefined) return doc;
  const targetIds = target
    ? (doc.panels[target]?.bubbleIds ?? [])
    : page.looseIds;
  return moveBubbleTo(doc, id, target, dir === 1 ? 0 : targetIds.length);
}

export function movePanelTo(doc: Doc, id: string, index: number): Doc {
  const panel = doc.panels[id];
  const page = panel ? doc.pages[panel.page] : undefined;
  if (!panel || !page) return doc;
  const ids = page.panelIds.filter((p) => p !== id);
  ids.splice(Math.max(0, Math.min(index, ids.length)), 0, id);
  if (ids.every((p, i) => p === page.panelIds[i])) return doc;
  return {
    ...doc,
    pages: { ...doc.pages, [page.number]: { ...page, panelIds: ids } },
  };
}

export function shiftPanel(doc: Doc, id: string, dir: -1 | 1): Doc {
  const panel = doc.panels[id];
  const page = panel ? doc.pages[panel.page] : undefined;
  if (!panel || !page) return doc;
  return movePanelTo(doc, id, page.panelIds.indexOf(id) + dir);
}

export function setBubbleRect(doc: Doc, id: string, rect: Rect): Doc {
  const bubble = doc.bubbles[id];
  if (!bubble) return doc;
  const next = withBubble(doc, id, { rect: clampRect(rect) });
  const moved = next.bubbles[id];
  if (!moved) return doc;
  if (moved.auto) return placeByBox(next, id);
  // A reviewed bubble keeps its place unless its box now sits in another panel.
  const current = panelOf(next, moved)?.id ?? null;
  const best = bestPanel(moved.rect, pagePanels(next, moved.page));
  return best && best !== current ? placeByBox(next, id) : next;
}

export function setPanelRect(doc: Doc, id: string, rect: Rect): Doc {
  const panel = doc.panels[id];
  if (!panel) return doc;
  let next: Doc = {
    ...doc,
    panels: { ...doc.panels, [id]: { ...panel, rect: clampRect(rect) } },
  };
  // Bubbles that sat outside every panel join one as soon as a panel covers them.
  for (const loose of next.pages[panel.page]?.looseIds ?? []) {
    const b = next.bubbles[loose];
    if (b && bestPanel(b.rect, pagePanels(next, panel.page)))
      next = placeByBox(next, loose);
  }
  return next;
}

/** A drawn bubble: empty, in the panel it overlaps most, ordered by its top-left corner. */
export function addBubble(doc: Doc, id: string, page: number, rect: Rect): Doc {
  const bubble: BubbleDoc = {
    id,
    page,
    rect: clampRect(rect),
    text: "",
    cues: null,
    type: "SPEECH",
    speakerId: null,
    rawSpeaker: null,
    emotion: "",
    silent: false,
    ignored: false,
    deleted: false,
    kept: false,
    auto: true,
    confidence: null,
    groupId: null,
  };
  return placeByBox({ ...doc, bubbles: { ...doc.bubbles, [id]: bubble } }, id);
}

export function setDeleted(doc: Doc, ids: string[], deleted: boolean): Doc {
  let next = doc;
  for (const id of ids) next = withBubble(next, id, { deleted });
  return next;
}

/**
 * A drawn panel: it takes its place in reading order by its top-left corner,
 * and every bubble that now overlaps it more than any other panel moves in.
 */
export function addPanel(doc: Doc, id: string, page: number, rect: Rect): Doc {
  const pageDoc = doc.pages[page];
  if (!pageDoc) return doc;
  const panel: PanelDoc = { id, page, rect: clampRect(rect), bubbleIds: [] };
  const ids = pageDoc.panelIds;
  let at = ids.findIndex((other) => {
    const p = doc.panels[other];
    return p ? comesBefore(panel.rect, p.rect) : false;
  });
  if (at === -1) at = ids.length;
  let next: Doc = {
    ...doc,
    panels: { ...doc.panels, [id]: panel },
    pages: {
      ...doc.pages,
      [page]: {
        ...pageDoc,
        panelIds: [...ids.slice(0, at), id, ...ids.slice(at)],
      },
    },
  };
  for (const bubbleId of pageBubbleIds(doc, page)) {
    const b = next.bubbles[bubbleId];
    if (b && bestPanel(b.rect, pagePanels(next, page)) === id)
      next = placeByBox(next, bubbleId);
  }
  return next;
}

/** Delete a panel. Its bubbles move to the panel they overlap most, or to none. */
export function removePanel(doc: Doc, id: string): Doc {
  const panel = doc.panels[id];
  const page = panel ? doc.pages[panel.page] : undefined;
  if (!panel || !page) return doc;
  let next: Doc = {
    ...doc,
    panels: Object.fromEntries(
      Object.entries(doc.panels).filter(([key]) => key !== id),
    ),
    pages: {
      ...doc.pages,
      [page.number]: {
        ...page,
        panelIds: page.panelIds.filter((p) => p !== id),
        looseIds: [...page.looseIds, ...panel.bubbleIds],
      },
    },
  };
  for (const bubbleId of panel.bubbleIds) next = placeByBox(next, bubbleId);
  return next;
}

/** Add a character to the closed list and hand it every bubble that named it. */
export function addCast(doc: Doc, member: AddedCast, alsoMatch?: string): Doc {
  if (doc.addedCast.some((c) => c.id === member.id)) return doc;
  const keys = new Set([member.id, slug(member.name)]);
  if (alsoMatch) keys.add(slug(alsoMatch));
  const bubbles = { ...doc.bubbles };
  for (const b of Object.values(doc.bubbles)) {
    if (!b.speakerId && b.rawSpeaker && keys.has(slug(b.rawSpeaker))) {
      bubbles[b.id] = { ...b, speakerId: member.id, rawSpeaker: null };
    }
  }
  return { ...doc, bubbles, addedCast: [...doc.addedCast, member] };
}

// ------------------------------------------------------- joined balloons

/**
 * The live bubbles that share this bubble's `groupId`, itself included, in
 * play order; empty when it stands alone (no id, or one nobody else holds).
 * Groups never span pages, so only its page is searched.
 */
export function groupMembers(doc: Doc, id: string): BubbleDoc[] {
  const b = doc.bubbles[id];
  if (!b?.groupId || b.deleted) return [];
  const members = visibleBubbles(doc, pageBubbleIds(doc, b.page)).filter(
    (o) => o.groupId === b.groupId,
  );
  return members.length >= 2 ? members : [];
}

/**
 * The balloon this one can join in direction `dir`: its neighbour in play
 * order inside its panel. Or why it cannot, in words the inspector shows.
 */
export function joinNeighbour(
  doc: Doc,
  id: string,
  dir: -1 | 1,
): { id: string } | { reason: string } {
  const b = doc.bubbles[id];
  if (!b || b.deleted) return { reason: "No such balloon." };
  if (b.ignored) return { reason: "Ignored balloons are not read." };
  if (b.silent) return { reason: "Silent balloons are not voiced." };
  const panel = panelOf(doc, b);
  if (!panel) return { reason: "Balloons join only inside one panel." };
  const ids = visibleBubbles(doc, panel.bubbleIds).map((o) => o.id);
  const n = doc.bubbles[ids[ids.indexOf(id) + dir] ?? ""];
  const which = dir === -1 ? "previous" : "next";
  if (!n)
    return {
      reason: `It is the ${dir === -1 ? "first" : "last"} balloon in its panel.`,
    };
  if (n.ignored) return { reason: `The ${which} balloon is ignored.` };
  if (n.silent) return { reason: `The ${which} balloon is silent.` };
  if (b.groupId && b.groupId === n.groupId)
    return { reason: `Already joined with the ${which} balloon.` };
  return { id: n.id };
}

/** Set `groupId` on every bubble of `page` that holds `from`. */
function regroup(
  bubbles: Record<string, BubbleDoc>,
  page: number,
  from: string,
  to: string,
): void {
  for (const o of Object.values(bubbles)) {
    if (o.page === page && o.groupId === from)
      bubbles[o.id] = { ...o, groupId: to };
  }
}

/**
 * Join a balloon with its neighbour in play order inside one panel (#451).
 * One side's group, shared or alone, takes in the other; with neither, both
 * get a fresh id; with two groups, the neighbour's group takes this one's.
 * Every member then takes the lead's speaker (the lead is first in play
 * order). Type is left alone. Throws on a pair the UI never offers.
 */
export function joinWith(
  doc: Doc,
  id: string,
  neighborId: string,
  mint: Mint,
): Doc {
  const a = doc.bubbles[id];
  const n = doc.bubbles[neighborId];
  const panel = a ? panelOf(doc, a) : null;
  const ids = panel
    ? visibleBubbles(doc, panel.bubbleIds).map((o) => o.id)
    : [];
  if (
    !a ||
    !n ||
    a.page !== n.page ||
    !panel ||
    Math.abs(ids.indexOf(id) - ids.indexOf(neighborId)) !== 1 ||
    !ids.includes(neighborId)
  )
    throw new Error(
      `joinWith: ${neighborId} is not next to ${id} in one panel`,
    );

  const bubbles = { ...doc.bubbles };
  let target: string;
  if (a.groupId && n.groupId) {
    target = a.groupId;
    regroup(bubbles, a.page, n.groupId, target);
  } else if (a.groupId) {
    target = a.groupId;
    bubbles[n.id] = { ...n, groupId: target };
  } else if (n.groupId) {
    target = n.groupId;
    bubbles[a.id] = { ...a, groupId: target };
  } else {
    target = mint();
    bubbles[a.id] = { ...a, groupId: target };
    bubbles[n.id] = { ...n, groupId: target };
  }

  const next: Doc = { ...doc, bubbles };
  const members = visibleBubbles(next, pageBubbleIds(next, a.page)).filter(
    (o) => o.groupId === target,
  );
  const lead = members[0];
  if (lead) {
    for (const m of members) {
      if (m.speakerId !== lead.speakerId || m.rawSpeaker !== lead.rawSpeaker)
        bubbles[m.id] = {
          ...m,
          speakerId: lead.speakerId,
          rawSpeaker: lead.rawSpeaker,
        };
    }
  }
  return repairGroups(next, a.page, mint);
}

/**
 * Take a balloon out of its shared group: it gets an id of its own, so it
 * stands alone and is never auto-joined again. What is left breaks into its
 * runs (`repairGroups`): splitting the middle of three leaves two balloons
 * standing alone. No-op outside a shared group.
 */
export function splitFrom(doc: Doc, id: string, mint: Mint): Doc {
  const b = doc.bubbles[id];
  if (!b || groupMembers(doc, id).length === 0) return doc;
  return repairGroups(withBubble(doc, id, { groupId: mint() }), b.page, mint);
}

/**
 * "Not one line": both balloons of a touching pair are marked as standing
 * alone, each with its own fresh id, so the prompt goes away for good. A
 * side that already has an id is left as it is.
 */
export function standAlone(
  doc: Doc,
  id: string,
  otherId: string,
  mint: Mint,
): Doc {
  let next = doc;
  if (!doc.bubbles[id]?.groupId)
    next = withBubble(next, id, { groupId: mint() });
  if (!doc.bubbles[otherId]?.groupId)
    next = withBubble(next, otherId, { groupId: mint() });
  return next;
}

/** Makes a fresh group id: `newId` in the browser. */
export type Mint = () => string;

/** Voiced: neither ignored nor silent. Only voiced balloons are group members. */
function voiced(b: BubbleDoc): boolean {
  return !b.ignored && !b.silent;
}

/**
 * Keeps every joined group on a page a run (#451): two or more voiced
 * balloons next to each other in play order inside one panel, deleted and
 * unvoiced balloons skipped. A group that is not one run breaks apart: an
 * ignored or silent member gets an id of its own, the first run of two or
 * more keeps the group's id, a later run of two or more gets a new shared
 * one, and a run of one gets its own (it stands alone). One-member ids,
 * "stands alone" marks, are left as they are. Returns the same document when
 * every group is already one run.
 */
export function repairGroups(doc: Doc, page: number, mint: Mint): Doc {
  const live = visibleBubbles(doc, pageBubbleIds(doc, page));
  const panelOfId = new Map<string, string>();
  for (const p of pagePanels(doc, page))
    for (const id of p.bubbleIds) panelOfId.set(id, p.id);

  const holders = new Map<string, BubbleDoc[]>();
  for (const b of live)
    if (b.groupId)
      holders.set(b.groupId, [...(holders.get(b.groupId) ?? []), b]);

  const runs = new Map<string, string[][]>();
  let prev: BubbleDoc | null = null;
  for (const b of live.filter(voiced)) {
    const g = b.groupId;
    if (g) {
      const panel = panelOfId.get(b.id);
      const list = runs.get(g) ?? [];
      const continues =
        prev?.groupId === g &&
        panel !== undefined &&
        panelOfId.get(prev.id) === panel;
      if (continues) list[list.length - 1]!.push(b.id);
      else list.push([b.id]);
      runs.set(g, list);
    }
    prev = b;
  }

  const ids = new Map<string, string>();
  for (const [g, members] of holders) {
    if (members.length < 2) continue;
    const unvoiced = members.filter((m) => !voiced(m));
    const groupRuns = runs.get(g) ?? [];
    if (unvoiced.length === 0 && groupRuns.length === 1) continue;
    for (const m of unvoiced) ids.set(m.id, mint());
    let kept = false;
    for (const run of groupRuns) {
      if (run.length >= 2 && !kept) {
        kept = true;
        continue;
      }
      const shared = run.length >= 2 ? mint() : null;
      for (const m of run) ids.set(m, shared ?? mint());
    }
  }
  if (ids.size === 0) return doc;
  const bubbles = { ...doc.bubbles };
  for (const [id, groupId] of ids) {
    const b = bubbles[id];
    if (b) bubbles[id] = { ...b, groupId };
  }
  return { ...doc, bubbles };
}

/**
 * `repairGroups` on every page an edit touched: a page whose panel list, a
 * panel's bubble list or a bubble changed. The editor runs it after every
 * edit, so a move, Earlier/Later, a panel change, or marking a member
 * ignored or silent never leaves a group with a gap.
 */
export function repairChanged(before: Doc, after: Doc, mint: Mint): Doc {
  if (before === after) return after;
  const pages = new Set<number>();
  for (const [id, b] of Object.entries(after.bubbles))
    if (before.bubbles[id] !== b) pages.add(b.page);
  for (const [id, p] of Object.entries(after.panels))
    if (before.panels[id] !== p) pages.add(p.page);
  for (const [n, p] of Object.entries(after.pages))
    if (before.pages[Number(n)] !== p) pages.add(p.number);
  let next = after;
  for (const page of pages) next = repairGroups(next, page, mint);
  return next;
}

// ------------------------------------------------------------ pending edits

/**
 * One row's change: a row the other side lacks, the fields that differ, or
 * null for a row that is gone. Only the changed fields are held, so a stored
 * speaker edit laid over a fresh row leaves a text fix made elsewhere alone.
 */
type RowPatch<T> = { add: T } | { set: Partial<T> } | null;

/**
 * The difference between two documents. The pending edits are the patch from
 * the loaded rows to the document; undo history is stored as patches between
 * neighbours.
 */
export interface DocPatch {
  bubbles?: Record<string, RowPatch<BubbleDoc>>;
  panels?: Record<string, RowPatch<PanelDoc>>;
  pages?: Record<string, RowPatch<PageDoc>>;
  addedCast?: AddedCast[];
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function diffRecord<T extends object>(
  from: Record<string, T>,
  to: Record<string, T>,
): Record<string, RowPatch<T>> | undefined {
  let out: Record<string, RowPatch<T>> | undefined;
  for (const [key, row] of Object.entries(to)) {
    const before = from[key];
    if (before === row) continue;
    if (!before) {
      (out ??= {})[key] = { add: row };
      continue;
    }
    const set: Partial<T> = {};
    for (const field of Object.keys(row) as (keyof T)[]) {
      if (!same(before[field], row[field])) set[field] = row[field];
    }
    if (Object.keys(set).length > 0) (out ??= {})[key] = { set };
  }
  for (const key of Object.keys(from)) {
    if (!(key in to)) (out ??= {})[key] = null;
  }
  return out;
}

function patchRecord<T extends object>(
  record: Record<string, T>,
  patch: Record<string, RowPatch<T>> | undefined,
): Record<string, T> {
  if (!patch) return record;
  const next = { ...record };
  for (const [key, change] of Object.entries(patch)) {
    const row = next[key];
    if (change === null) delete next[key];
    else if ("add" in change) next[key] = change.add;
    // Fields for a row that is gone have nothing to land on.
    else if (row) next[key] = { ...row, ...change.set };
  }
  return next;
}

/** What turns `from` into `to`, or null when they hold the same rows. */
export function diffDoc(from: Doc, to: Doc): DocPatch | null {
  if (from === to) return null;
  const patch: DocPatch = {};
  const bubbles = diffRecord(from.bubbles, to.bubbles);
  const panels = diffRecord(from.panels, to.panels);
  const pages = diffRecord<PageDoc>(from.pages, to.pages);
  if (bubbles) patch.bubbles = bubbles;
  if (panels) patch.panels = panels;
  if (pages) patch.pages = pages;
  if (!same(from.addedCast, to.addedCast)) patch.addedCast = to.addedCast;
  return Object.keys(patch).length > 0 ? patch : null;
}

export function applyDocPatch(doc: Doc, patch: DocPatch | null): Doc {
  if (!patch) return doc;
  return {
    bubbles: patchRecord(doc.bubbles, patch.bubbles),
    panels: patchRecord(doc.panels, patch.panels),
    pages: patchRecord<PageDoc>(doc.pages, patch.pages),
    addedCast: patch.addedCast ?? doc.addedCast,
  };
}

/**
 * Stored edits meet rows that may have changed since. Ids with no row are
 * dropped from every list, a bubble stays in the first list that names it and
 * no other, and a bubble or panel no list names is put back by its box.
 * Returns the same document when there was nothing to repair.
 */
export function reconcile(doc: Doc): Doc {
  let changed = false;
  const seenPanels = new Set<string>();
  const seenBubbles = new Set<string>();
  const panels: Record<string, PanelDoc> = {};
  const pages: Record<number, PageDoc> = {};

  const keepBubbles = (ids: string[], page: number): string[] => {
    const kept = ids.filter((id) => {
      if (doc.bubbles[id]?.page !== page || seenBubbles.has(id)) return false;
      seenBubbles.add(id);
      return true;
    });
    if (kept.length === ids.length) return ids;
    changed = true;
    return kept;
  };

  for (const page of Object.values(doc.pages)) {
    const panelIds = page.panelIds.filter((id) => {
      if (doc.panels[id]?.page !== page.number || seenPanels.has(id))
        return false;
      seenPanels.add(id);
      return true;
    });
    for (const panel of Object.values(doc.panels)) {
      if (panel.page !== page.number || seenPanels.has(panel.id)) continue;
      seenPanels.add(panel.id);
      panelIds.push(panel.id);
    }
    const listSame =
      panelIds.length === page.panelIds.length &&
      panelIds.every((id, i) => id === page.panelIds[i]);
    if (!listSame) changed = true;
    for (const id of panelIds) {
      const panel = doc.panels[id];
      if (!panel) continue;
      const bubbleIds = keepBubbles(panel.bubbleIds, page.number);
      panels[id] =
        bubbleIds === panel.bubbleIds ? panel : { ...panel, bubbleIds };
    }
    const looseIds = keepBubbles(page.looseIds, page.number);
    pages[page.number] =
      listSame && looseIds === page.looseIds
        ? page
        : { ...page, panelIds, looseIds };
  }
  // A panel on a page that no longer exists has nowhere to show.
  if (Object.keys(panels).length !== Object.keys(doc.panels).length)
    changed = true;

  let next: Doc = changed ? { ...doc, panels, pages } : doc;
  for (const bubble of Object.values(doc.bubbles)) {
    if (!seenBubbles.has(bubble.id) && next.pages[bubble.page])
      next = placeByBox(next, bubble.id);
  }
  return next;
}
