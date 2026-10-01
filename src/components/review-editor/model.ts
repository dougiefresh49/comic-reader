// The editor's document: plain data plus pure operations, so undo is a stack of snapshots.
import { NARRATOR_ID, resolveSpeaker, slug } from "./lib";
import type {
  BubbleType,
  CastMember,
  EditorData,
  Face,
  Rect,
  SrcBubble,
} from "./types";

export interface BubbleDoc {
  id: string;
  page: number;
  rect: Rect;
  text: string;
  type: BubbleType;
  /** A cast id from the closed list, or null. */
  speakerId: string | null;
  /** The stored speaker string when it did not match the closed list. */
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
}

export interface PanelDoc {
  id: string;
  page: number;
  rect: Rect;
  bubbleIds: string[];
}

export interface PageDoc {
  number: number;
  panelIds: string[];
  /** Bubbles that overlap no panel. */
  looseIds: string[];
}

/**
 * The voice an added character takes: its own active voice, another
 * character's, or a new one to be made later. `voiceId` is `voices.id`; a
 * voice is never picked by its display name (decisions row 153).
 */
export type VoiceChoice =
  | { kind: "own"; voiceId: string }
  | { kind: "borrow"; voiceId: string }
  | { kind: "new" };

export interface AddedCast {
  id: string;
  name: string;
  voice: VoiceChoice;
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
  | { kind: "duplicate"; ofId: string };

export const SPOKEN: BubbleType[] = ["SPEECH", "NARRATION", "CAPTION"];

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

function toBubble(src: SrcBubble, cast: CastMember[]): BubbleDoc {
  const speakerId = resolveSpeaker(src.speaker, cast);
  return {
    id: src.id,
    page: src.page,
    rect: src.rect,
    text: src.text,
    type: src.type,
    speakerId,
    rawSpeaker: speakerId ? null : src.speaker,
    emotion: src.emotion,
    silent: false,
    ignored: src.ignored,
    deleted: false,
    kept: false,
    auto: false,
    confidence: src.confidence,
  };
}

export function initDoc(data: EditorData): Doc {
  const doc: Doc = { bubbles: {}, panels: {}, pages: {}, addedCast: [] };
  for (const page of data.pages) {
    doc.pages[page.number] = {
      number: page.number,
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
    const flags = pageFlags(doc, n);
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

export function setSpeaker(doc: Doc, id: string, castId: string | null): Doc {
  return withBubble(doc, id, { speakerId: castId, rawSpeaker: null });
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
