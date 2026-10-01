// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// The editor's document: plain data plus pure operations, so undo is a stack of snapshots.
import { resolveSpeaker, slug } from "../lib";
import type {
  BubbleType,
  CastMember,
  ProtoData,
  Rect,
  SrcBubble,
} from "../types";

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
  /** Dismissed as a duplicate detection. Kept in place so it can be restored. */
  dismissed: boolean;
  /** The owner said this overlap is not a duplicate. */
  kept: boolean;
  /** Drawn in this session and still waiting for analyze to be accepted. */
  pending: boolean;
  /** Drawn in this session and never reordered by hand: it re-sorts as its box moves. */
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
  approved: boolean;
}

export type VoiceChoice = { kind: "borrow"; voice: string } | { kind: "new" };

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
  issueApproved: boolean;
}

export interface Sel {
  kind: "bubble" | "panel";
  id: string;
}

export type Flag =
  | { kind: "no-speaker" }
  | { kind: "unknown-speaker"; raw: string }
  | { kind: "duplicate"; ofId: string }
  | { kind: "proposal" };

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

/** The panel a box overlaps most, or null when it touches none. */
export function bestPanel(rect: Rect, panels: PanelDoc[]): string | null {
  let best: string | null = null;
  let bestArea = 0;
  for (const p of panels) {
    const a = intersection(rect, p.rect);
    if (a > bestArea) {
      bestArea = a;
      best = p.id;
    }
  }
  return best;
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
    dismissed: false,
    kept: false,
    pending: false,
    auto: false,
    confidence: src.confidence,
  };
}

export function initDoc(data: ProtoData): Doc {
  const doc: Doc = {
    bubbles: {},
    panels: {},
    pages: {},
    addedCast: [],
    issueApproved: false,
  };
  for (const page of data.pages) {
    doc.pages[page.number] = {
      number: page.number,
      panelIds: [],
      looseIds: [],
      approved: false,
    };
  }
  const linked = new Map<string, string>();
  for (const p of data.panels) {
    doc.panels[p.id] = { id: p.id, page: p.page, rect: p.rect, bubbleIds: [] };
    doc.pages[p.page]?.panelIds.push(p.id);
    for (const id of p.bubbleIds) linked.set(id, p.id);
  }
  // Rows arrive in play order, so appending keeps that order inside each panel.
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

/** Every bubble id of a page in play order, dismissed ones included. */
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
    return b && !b.dismissed ? [b] : [];
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
    if (b.pending) {
      add(b.id, { kind: "proposal" });
      continue;
    }
    if (!SPOKEN.includes(b.type) || b.silent || b.speakerId) continue;
    if (b.rawSpeaker) add(b.id, { kind: "unknown-speaker", raw: b.rawSpeaker });
    else add(b.id, { kind: "no-speaker" });
  }

  // A duplicate detection is a box that swallows another balloon's box, or a
  // near-identical twin with the lower confidence.
  live.forEach((a, ai) => {
    if (a.kept || a.pending) return;
    for (let bi = 0; bi < live.length; bi++) {
      const b = live[bi];
      if (!b || bi === ai || b.pending) continue;
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
  return withBubble(doc, id, patch);
}

export function setSpeaker(doc: Doc, id: string, castId: string | null): Doc {
  return withBubble(doc, id, {
    speakerId: castId,
    rawSpeaker: null,
    pending: castId ? false : (doc.bubbles[id]?.pending ?? false),
  });
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
    if (!other || other.dismissed) continue;
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
  // Step over dismissed rows so one press is one visible move.
  let to = at + dir;
  while (to >= 0 && to < ids.length && doc.bubbles[ids[to] ?? ""]?.dismissed)
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
    dismissed: false,
    kept: false,
    pending: true,
    auto: true,
    confidence: null,
  };
  return placeByBox({ ...doc, bubbles: { ...doc.bubbles, [id]: bubble } }, id);
}

export function setDismissed(doc: Doc, ids: string[], dismissed: boolean): Doc {
  let next = doc;
  for (const id of ids) next = withBubble(next, id, { dismissed });
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

export function setPageApproved(
  doc: Doc,
  pageNumber: number,
  approved: boolean,
): Doc {
  const page = doc.pages[pageNumber];
  if (!page || page.approved === approved) return doc;
  return {
    ...doc,
    issueApproved: approved ? doc.issueApproved : false,
    pages: { ...doc.pages, [pageNumber]: { ...page, approved } },
  };
}

export function isDoc(value: unknown): value is Doc {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Doc>;
  return (
    typeof v.bubbles === "object" &&
    typeof v.panels === "object" &&
    typeof v.pages === "object" &&
    Array.isArray(v.addedCast)
  );
}
