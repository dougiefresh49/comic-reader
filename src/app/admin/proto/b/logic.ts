// THROWAWAY spike for issue #325 (review editor variant B). Pure helpers: geometry, signals, order.

import {
  SPOKEN_TYPES,
  type Box,
  type CastMember,
  type EditState,
  type ProtoBubble,
  type ProtoPanel,
  type Signal,
  type SignalKey,
} from "./types";

export const GENERIC_ROLES: CastMember[] = [
  { id: "narrator", name: "Narrator", aliases: [], kind: "generic" },
  { id: "off-panel", name: "Off-panel", aliases: [], kind: "generic" },
  { id: "crowd", name: "Crowd", aliases: [], kind: "generic" },
];

export const SIGNAL_LABEL: Record<SignalKey, string> = {
  "no-speaker": "No speaker",
  "off-list": "Not in cast",
  duplicate: "Duplicate",
  merged: "Merged",
  "no-panel": "No panel",
  "not-in-panel": "Face not in panel",
  "low-confidence": "Low confidence",
  new: "New bubble",
};

/** Lower rank is more urgent. */
export const SIGNAL_RANK: Record<SignalKey, number> = {
  "no-speaker": 0,
  "off-list": 1,
  duplicate: 2,
  merged: 3,
  "no-panel": 4,
  new: 5,
  "not-in-panel": 6,
  "low-confidence": 7,
};

export const SIGNAL_TONE: Record<SignalKey, string> = {
  "no-speaker": "text-red-300 border-red-800",
  "off-list": "text-amber-300 border-amber-800",
  duplicate: "text-orange-300 border-orange-800",
  merged: "text-orange-300 border-orange-800",
  "no-panel": "text-amber-300 border-amber-800",
  new: "text-cyan-300 border-cyan-800",
  "not-in-panel": "text-neutral-300 border-neutral-700",
  "low-confidence": "text-neutral-300 border-neutral-700",
};

export function normName(s: string): string {
  return s.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

export function area(b: Box): number {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

export function intersect(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function clampBox(b: Box): Box {
  const w = Math.min(Math.max(b.w, 0.005), 1);
  const h = Math.min(Math.max(b.h, 0.005), 1);
  return {
    x: Math.min(Math.max(b.x, 0), 1 - w),
    y: Math.min(Math.max(b.y, 0), 1 - h),
    w,
    h,
  };
}

export function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export function pad(b: Box, by: number): Box {
  const x = Math.max(0, b.x - by);
  const y = Math.max(0, b.y - by);
  return {
    x,
    y,
    w: Math.min(1, b.x + b.w + by) - x,
    h: Math.min(1, b.y + b.h + by) - y,
  };
}

/** The panel a bubble belongs to: its stored link, else the panel it overlaps most. */
export function panelOf(
  b: ProtoBubble,
  panels: Record<string, ProtoPanel>,
): ProtoPanel | null {
  if (b.panelId) {
    const p = panels[b.panelId];
    if (p) return p;
  }
  let best: ProtoPanel | null = null;
  let bestArea = 0;
  for (const p of Object.values(panels)) {
    if (p.page !== b.page) continue;
    const a = intersect(b.box, p.box);
    if (a > bestArea) {
      bestArea = a;
      best = p;
    }
  }
  return best;
}

export function panelsOnPage(
  panels: Record<string, ProtoPanel>,
  page: number,
): ProtoPanel[] {
  return Object.values(panels)
    .filter((p) => p.page === page)
    .sort((a, b) => a.order - b.order);
}

/** Reading comparison by top-left corner: rows top to bottom, then left to right. */
export function readsBefore(a: Box, b: Box): boolean {
  const tol = Math.min(a.h, b.h) * 0.5;
  if (Math.abs(a.y - b.y) <= tol) return a.x < b.x;
  return a.y < b.y;
}

export interface PanelGroup {
  panel: ProtoPanel | null;
  bubbles: ProtoBubble[];
}

/** A page's bubbles grouped by panel in panel order; this is the play order. */
export function groupPage(state: EditState, page: number): PanelGroup[] {
  const ids = state.order[page] ?? [];
  const panels = panelsOnPage(state.panels, page);
  const groups = new Map<string, PanelGroup>();
  for (const p of panels) groups.set(p.id, { panel: p, bubbles: [] });
  const loose: PanelGroup = { panel: null, bubbles: [] };
  for (const id of ids) {
    const b = state.bubbles[id];
    if (!b) continue;
    const p = panelOf(b, state.panels);
    const g = p ? groups.get(p.id) : undefined;
    (g ?? loose).bubbles.push(b);
  }
  const out = panels.map((p) => groups.get(p.id)!);
  if (loose.bubbles.length) out.push(loose);
  return out;
}

export function playOrder(state: EditState, page: number): ProtoBubble[] {
  return groupPage(state, page).flatMap((g) => g.bubbles);
}

/**
 * Put `id` into the page order inside its panel's run, placed by its box's
 * top-left corner. The bubble must already carry its final panel and box.
 */
export function placeInOrder(state: EditState, id: string): string[] {
  const b = state.bubbles[id];
  if (!b) return [];
  const without = (state.order[b.page] ?? []).filter((x) => x !== id);
  const target = panelOf(b, state.panels);
  const mates = without.filter((x) => {
    const o = state.bubbles[x];
    if (!o) return false;
    const p = panelOf(o, state.panels);
    return (p?.id ?? null) === (target?.id ?? null);
  });
  const after = mates.find((x) => {
    const o = state.bubbles[x];
    return o ? readsBefore(b.box, o.box) : false;
  });
  if (after) {
    const i = without.indexOf(after);
    return [...without.slice(0, i), id, ...without.slice(i)];
  }
  const last = mates[mates.length - 1];
  if (last) {
    const i = without.indexOf(last);
    return [...without.slice(0, i + 1), id, ...without.slice(i + 1)];
  }
  return [...without, id];
}

function words(s: string): Set<string> {
  return new Set(
    s
      .toUpperCase()
      .replace(/[^A-Z0-9' ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function containedShare(small: Set<string>, big: Set<string>): number {
  if (!small.size) return 0;
  let inter = 0;
  for (const w of small) if (big.has(w)) inter++;
  return inter / small.size;
}

export interface CastIndex {
  all: CastMember[];
  byId: Map<string, CastMember>;
  byNorm: Map<string, CastMember>;
  /** First-word or full alias lookups for names that are not in the list. */
  aliasHint: (name: string) => CastMember | null;
}

export function buildCast(base: CastMember[], added: CastMember[]): CastIndex {
  const all = [...base, ...GENERIC_ROLES, ...added];
  const byId = new Map(all.map((c) => [c.id, c]));
  const byNorm = new Map<string, CastMember>();
  for (const c of all) {
    byNorm.set(normName(c.id), c);
    byNorm.set(normName(c.name), c);
  }
  const aliasHint = (name: string): CastMember | null => {
    const n = normName(name);
    for (const c of all) {
      for (const a of c.aliases) {
        const na = normName(a);
        if (na === n || na.split(" ")[0] === n) return c;
      }
    }
    // A multi-name speaker ("Michelangelo, Red Ranger"): suggest the first one.
    const first = name.split(/,|&| and /)[0];
    if (first && first !== name) {
      const hit = byNorm.get(normName(first));
      if (hit) return hit;
    }
    return null;
  };
  return { all, byId, byNorm, aliasHint };
}

export function speakerName(cast: CastIndex, speaker: string | null): string {
  if (!speaker) return "";
  return cast.byNorm.get(normName(speaker))?.name ?? speaker;
}

export function inCast(cast: CastIndex, speaker: string | null): boolean {
  return !!speaker && cast.byNorm.has(normName(speaker));
}

export function needsSpeaker(b: ProtoBubble): boolean {
  return SPOKEN_TYPES.has(b.type) && !b.ignored && !b.silent && !b.speaker;
}

/**
 * Every signal for every live bubble in the issue. Ignored bubbles carry none.
 * The rules are guesses meant to over-reach; each one can be switched off in
 * the queue's filter row.
 */
export function computeSignals(
  state: EditState,
  cast: CastIndex,
): Map<string, Signal[]> {
  const out = new Map<string, Signal[]>();
  const live = Object.values(state.bubbles).filter((b) => !b.ignored);
  const byPage = new Map<number, ProtoBubble[]>();
  for (const b of live) {
    const list = byPage.get(b.page) ?? [];
    list.push(b);
    byPage.set(b.page, list);
  }

  const push = (id: string, s: Signal) => {
    const list = out.get(id) ?? [];
    list.push(s);
    out.set(id, list);
  };

  for (const [, list] of byPage) {
    const tokens = new Map(list.map((b) => [b.id, words(b.text)]));
    const twins = new Map<string, Set<string>>();
    const contains = new Map<string, string[]>();

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const inter = intersect(a.box, b.box);
        if (inter <= 0) continue;
        const minA = Math.min(area(a.box), area(b.box));
        const share = minA > 0 ? inter / minA : 0;
        const ta = tokens.get(a.id)!;
        const tb = tokens.get(b.id)!;
        const sim = jaccard(ta, tb);
        if (share > 0.6 && sim > 0.6) {
          const sa = twins.get(a.id) ?? new Set<string>();
          sa.add(b.id);
          twins.set(a.id, sa);
          const sb = twins.get(b.id) ?? new Set<string>();
          sb.add(a.id);
          twins.set(b.id, sb);
          continue;
        }
        // A box that swallows most of a smaller one, and whose text holds
        // the smaller one's words, is a candidate merge of several balloons.
        const [big, small] = area(a.box) >= area(b.box) ? [a, b] : [b, a];
        if (
          inter / Math.max(area(small.box), 1e-9) > 0.75 &&
          containedShare(tokens.get(small.id)!, tokens.get(big.id)!) > 0.6
        ) {
          contains.set(big.id, [...(contains.get(big.id) ?? []), small.id]);
        }
      }
    }

    for (const b of list) {
      const t = twins.get(b.id);
      if (t?.size) {
        const others = [...t];
        const speakers = new Set(
          [b, ...others.map((x) => state.bubbles[x]!)].map((x) =>
            normName(x.speaker ?? ""),
          ),
        );
        push(b.id, {
          key: "duplicate",
          detail: `Same text and box as ${others.length} other detection${others.length > 1 ? "s" : ""}${speakers.size > 1 ? ", and they disagree on the speaker" : ""}.`,
          related: others,
        });
      }
      const parts = contains.get(b.id) ?? [];
      const reasons: string[] = [];
      if (parts.length >= 2)
        reasons.push(`its box covers ${parts.length} other bubbles`);
      if (/\n\s*\n/.test(b.text)) reasons.push("its text has a blank line");
      if (b.speaker && /,|&| and /.test(b.speaker))
        reasons.push("it names more than one speaker");
      if (reasons.length) {
        push(b.id, {
          key: "merged",
          detail: `Looks like several balloons read as one: ${reasons.join(", ")}.`,
          related: parts,
        });
      }
    }
  }

  for (const b of live) {
    const panel = panelOf(b, state.panels);
    if (needsSpeaker(b)) {
      push(b.id, {
        key: "no-speaker",
        detail: "A spoken bubble with no speaker blocks approval.",
      });
    } else if (
      b.speaker &&
      SPOKEN_TYPES.has(b.type) &&
      !inCast(cast, b.speaker)
    ) {
      const hint = cast.aliasHint(b.speaker);
      push(b.id, {
        key: "off-list",
        detail: hint
          ? `"${b.speaker}" is not in the cast list. Likely ${hint.name}.`
          : `"${b.speaker}" is not in the cast list.`,
        suggest: hint?.id,
      });
    } else if (
      b.speaker &&
      panel &&
      panel.faces.length > 0 &&
      SPOKEN_TYPES.has(b.type) &&
      cast.byNorm.get(normName(b.speaker))?.kind === "cast" &&
      !panel.faces.includes(cast.byNorm.get(normName(b.speaker))!.id)
    ) {
      push(b.id, {
        key: "not-in-panel",
        detail: `${speakerName(cast, b.speaker)}'s face was not detected in this panel (found: ${panel.faces.map((f) => cast.byId.get(f)?.name ?? f).join(", ")}).`,
      });
    }
    if (!panel) {
      push(b.id, {
        key: "no-panel",
        detail: "The box does not overlap any panel.",
      });
    }
    if (b.confidence !== null && b.confidence < 0.6) {
      push(b.id, {
        key: "low-confidence",
        detail: `The detector gave this box ${Math.round(b.confidence * 100)}%.`,
      });
    }
    if (b.isNew) {
      push(b.id, { key: "new", detail: "You drew this bubble." });
    }
  }

  for (const [, list] of out) {
    list.sort((a, b) => SIGNAL_RANK[a.key] - SIGNAL_RANK[b.key]);
  }
  return out;
}

/**
 * The speaker shortlist for a bubble: an alias suggestion, faces detected in
 * its panel, the generic roles, then the rest of the page's faces. Nine at
 * most, one per number key.
 */
export function shortlist(
  b: ProtoBubble,
  state: EditState,
  cast: CastIndex,
  suggest?: string,
): CastMember[] {
  const ids: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !ids.includes(id) && cast.byId.has(id)) ids.push(id);
  };
  add(suggest);
  const panel = panelOf(b, state.panels);
  if (b.type === "CAPTION" || b.type === "NARRATION") add("narrator");
  for (const f of panel?.faces ?? []) add(f);
  add("off-panel");
  add("narrator");
  add("crowd");
  for (const p of panelsOnPage(state.panels, b.page))
    for (const f of p.faces) add(f);
  for (const c of state.addedCast) add(c.id);
  // The current speaker goes last, so picking one never renumbers the list.
  const top = ids.slice(0, 9);
  const current = b.speaker
    ? cast.byNorm.get(normName(b.speaker))?.id
    : undefined;
  if (current && !top.includes(current)) {
    if (top.length === 9) top[8] = current;
    else top.push(current);
  }
  return top.map((id) => cast.byId.get(id)!);
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
