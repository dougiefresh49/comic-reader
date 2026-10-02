// The workbench: an icon rail and the tree on the left, the page on a canvas, the selection's fields on the right.
"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AnalyzeProposal } from "~/server/actions/review/analyze-bubble";
import { useAnalyze, type AnalyzePhase } from "./analyze";
import { Canvas, type CanvasHandle, type Tool } from "./Canvas";
import { Inspector, Key, type Actions, type ListenView } from "./Inspector";
import { findCast, needYou, newId, ownVoice, plural, slug } from "./lib";
import { takesDropped, useListen, type SavedRow } from "./listen";
import {
  addBubble,
  addCast,
  addPanel,
  diffDoc,
  facesIn,
  initDoc,
  issueFlags,
  moveBubbleTo,
  moveBubbleToPanel,
  movePanelTo,
  pageBubbleIds,
  pageFlags,
  pagePanels,
  panelOf,
  patchBubble,
  removePanel,
  setBubbleRect,
  setDeleted,
  setPanelRect,
  setSpeaker,
  shiftBubble,
  shiftPanel,
  visibleBubbles,
  type BubbleDoc,
  type Doc,
  type Sel,
} from "./model";
import {
  backupKey,
  clearLocal,
  editsKey,
  LAYOUT_KEY,
  readLocal,
  readRaw,
  writeLocal,
  writeRaw,
} from "./storage";
import type { SaveResult } from "~/app/api/apply-fixes/write-rules";
import { buildSave, saveCount } from "./save";
import { packState, reducer, restoreState, storedRev } from "./store";
import { Tree } from "./Tree";
import type { CastMember, EditorData, Rect, SrcPage } from "./types";

interface WorkbenchProps {
  data: EditorData;
  /** From `?page=`; null means "wherever this browser was last". */
  initialPage: number | null;
}

interface Note {
  n: number;
  text: string;
  tone: "plain" | "warn";
}

const TYPE_KEYS: Record<string, BubbleDoc["type"]> = {
  "1": "SPEECH",
  "2": "NARRATION",
  "3": "CAPTION",
  "4": "SFX",
  "5": "BACKGROUND",
};

const SHEET: { title: string; rows: [string, string][] }[] = [
  {
    title: "Move around",
    rows: [
      ["↓ / J", "Next panel or bubble, runs on into the next page"],
      ["↑ / K", "Previous panel or bubble"],
      ["→ / ] / PgDn", "Next page"],
      ["← / [ / PgUp", "Previous page"],
      ["N", "Next bubble that needs you, on any page"],
      ["Shift N", "Previous bubble that needs you"],
      ["Esc", "Leave a field or a draw tool, then clear the selection"],
    ],
  },
  {
    title: "Edit the selected bubble",
    rows: [
      ["E / Enter", "Edit the text. Enter accepts a proposal when one shows"],
      [
        "R",
        "While a proposal shows: try again, analyzing the bubble once more with its hint",
      ],
      ["L", "Play the bubble's audio. L again stops it"],
      [
        "S",
        "Pick the speaker. Enter takes the highlighted name: the nearest face, or the first match once you type",
      ],
      ["M", "Edit the emotion"],
      ["1 to 5", "Speech, narration, caption, SFX, background"],
      ["X", "Silent: shown, no audio"],
      ["I", "Ignored: not read"],
      ["D", "Dismiss a duplicate"],
      ["Y", "Keep both: not a duplicate"],
    ],
  },
  {
    title: "Order and boxes",
    rows: [
      ["Alt ↑ / ↓", "Earlier or later in play order, crosses panels"],
      ["Shift arrows", "Move the box"],
      ["Alt Shift arrows", "Resize the box"],
      ["V", "Back to the select tool"],
      ["B", "Draw a bubble with the mouse"],
      ["Shift B", "Drop a bubble in the current panel"],
      ["P", "Draw a panel with the mouse"],
      ["Delete", "Delete the selected bubble or panel. Backspace too"],
    ],
  },
  {
    title: "History",
    rows: [
      ["Cmd Z", "Undo. Ctrl works in place of Cmd"],
      ["Shift Cmd Z", "Redo"],
      ["Cmd S", "Save every pending edit. Ctrl works in place of Cmd"],
    ],
  },
  {
    title: "View",
    rows: [
      ["Space drag", "Pan. The wheel pans too"],
      ["Cmd wheel", "Zoom at the cursor"],
      ["+ / = / -", "Zoom in and out"],
      ["Z", "Zoom to the selected panel"],
      ["0", "Fit the page"],
      ["F", "Show only what needs you"],
      [", and .", "Fold the left and right drawers"],
      ["?", "This sheet"],
    ],
  },
];

const TOOLS: [Tool, string, string][] = [
  ["select", "Select", "V"],
  ["bubble", "Draw bubble", "B"],
  ["panel", "Draw panel", "P"],
];

const DRAW_HINT: Record<Exclude<Tool, "select">, string> = {
  bubble:
    "Drag a box around the balloon. It sorts itself into its panel. Esc cancels.",
  panel:
    "Drag a box around the panel. The bubbles it covers most move into it. Esc cancels.",
};

/**
 * What the left drawer can show. The rail has one button per entry; a second
 * view is an entry here and a branch where the drawer renders `leftView`.
 */
const RAIL = [
  {
    id: "order",
    label: "Pages and reading order",
    icon: "M2 3.5h12M5 8h9M5 12.5h9",
  },
] as const;
type LeftView = (typeof RAIL)[number]["id"];

interface Widths {
  left: number;
  right: number;
}
const LEFT = { min: 220, max: 560, initial: 304 };
const RIGHT = { min: 260, max: 600, initial: 328 };
const RAIL_WIDTH = 40;
/** The drawers never squeeze the canvas below this. */
const CANVAS_MIN = 320;

/** How edits made here stand with localStorage. */
type Kept = "kept" | "no-history" | "failed" | "stale";

function clampWidth(
  value: unknown,
  limits: { min: number; max: number; initial?: number },
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(limits.max, Math.max(limits.min, Math.round(value)))
    : (limits.initial ?? limits.min);
}

function readWidths(): Widths {
  const stored = (readLocal(LAYOUT_KEY) ?? {}) as Partial<Widths>;
  return {
    left: clampWidth(stored.left, LEFT),
    right: clampWidth(stored.right, RIGHT),
  };
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 8 8" className="size-2" aria-hidden>
      <path
        d={dir === "left" ? "M5.5 1L2 4l3.5 3" : "M2.5 1L6 4 2.5 7"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

/** The inner edge of a drawer: drag it to change the drawer's width. */
function ResizeHandle({
  drawer,
  width,
  limits,
  onResize,
}: {
  drawer: "left" | "right";
  width: number;
  limits: { min: number; max: number };
  onResize: (width: number) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    start.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${drawer} drawer`}
      aria-valuenow={width}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      title="Drag to resize"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const dx = e.clientX - s.x;
        onResize(clampWidth(s.width + (drawer === "left" ? dx : -dx), limits));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      className={`absolute top-0 z-40 h-full w-[7px] cursor-col-resize touch-none hover:bg-neutral-500/60 active:bg-neutral-300/70 ${
        drawer === "left" ? "-right-1" : "-left-1"
      }`}
    />
  );
}

const BAR_BUTTON =
  "flex h-6 items-center gap-1.5 rounded-sm border border-neutral-800 px-2 text-neutral-300 hover:border-neutral-600 hover:text-white disabled:text-neutral-600 disabled:hover:border-neutral-800";
const FLOAT =
  "rounded-sm border border-neutral-700 bg-neutral-950/90 text-neutral-400";

const subscribeNever = () => () => undefined;

/**
 * The editor starts from what the browser holds (pending edits, drawer
 * widths), so it renders only in the browser.
 */
export function Workbench(props: WorkbenchProps) {
  const inBrowser = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  if (!inBrowser) return <div className="h-screen bg-neutral-950" />;
  return <Editor {...props} />;
}

function Editor({ data, initialPage }: WorkbenchProps) {
  const firstPage = data.pages[0]?.number ?? 1;
  const storeKey = editsKey(data.bookId, data.issueId);
  // What the browser held when the editor opened. A stored value that cannot
  // be restored is copied aside here, before anything can write over it.
  const [boot] = useState(() => {
    const raw = readRaw(storeKey);
    const restored = restoreState(initDoc(data), raw, initialPage, firstPage);
    const notices: string[] = [];
    if (restored.unreadable && raw !== null) {
      const copyKey = backupKey(data.bookId, data.issueId);
      notices.push(
        writeRaw(copyKey, raw)
          ? `The edits this browser held for this issue could not be read, so the editor started from the rows as loaded. The stored value was copied to "${copyKey}" in this browser's local storage.`
          : "The edits this browser held for this issue could not be read, and could not be copied aside. The editor started from the rows as loaded; the next edit replaces what was stored.",
      );
    }
    if (restored.rowsChanged)
      notices.push(
        "This issue's rows changed since these edits were made. The edits were laid over the rows as they are now, and the undo history was cleared.",
      );
    return { ...restored, notices };
  });
  const [state, dispatch] = useReducer(reducer, boot.state);
  const { doc, page: pageNumber, sel } = state;
  const [kept, setKept] = useState<Kept>("kept");
  const [notices, setNotices] = useState(boot.notices);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [viewport, setViewport] = useState(() => window.innerWidth);

  const [tool, setTool] = useState<Tool>("select");
  const [hover, setHover] = useState<Sel | null>(null);
  const [leftView, setLeftView] = useState<LeftView>("order");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [pagesOpen, setPagesOpen] = useState(true);
  const [widths, setWidths] = useState(readWidths);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [picker, setPicker] = useState<{
    open: boolean;
    addName: string | null;
  }>({ open: false, addName: null });
  const [zoom, setZoom] = useState(0);
  const [note, setNote] = useState<Note | null>(null);
  const [sheet, setSheet] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const canvasRef = useRef<CanvasHandle>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const emotionRef = useRef<HTMLInputElement>(null);

  const say = useCallback((text: string, tone: Note["tone"] = "plain") => {
    setNote((prev) => ({ n: (prev?.n ?? 0) + 1, text, tone }));
  }, []);

  // ------------------------------------------------------------- derived

  const pagesByNumber = useMemo(
    () => new Map<number, SrcPage>(data.pages.map((p) => [p.number, p])),
    [data.pages],
  );
  const page = pagesByNumber.get(pageNumber) ?? data.pages[0];

  const voiceById = useMemo(
    () => new Map(data.voices.map((v) => [v.id, v])),
    [data.voices],
  );
  const cast = useMemo<CastMember[]>(() => {
    const added: CastMember[] = doc.addedCast.map((c, i) => ({
      id: c.id,
      name: c.name,
      aliases: [],
      kind: "character",
      tint: data.cast.length + i,
      voice:
        c.voice.kind === "new"
          ? null
          : (voiceById.get(c.voice.voiceId) ?? null),
      newVoice: c.voice.kind === "new",
      portrait: null,
    }));
    return [
      ...[...data.cast.filter((c) => c.kind === "character"), ...added].sort(
        (a, b) => a.name.localeCompare(b.name),
      ),
      ...data.cast.filter((c) => c.kind === "role"),
    ];
  }, [data.cast, doc.addedCast, voiceById]);
  const castById = useMemo(() => new Map(cast.map((c) => [c.id, c])), [cast]);

  const panels = useMemo(() => pagePanels(doc, pageNumber), [doc, pageNumber]);
  const flags = useMemo(() => pageFlags(doc, pageNumber), [doc, pageNumber]);
  const allFlags = useMemo(() => issueFlags(doc), [doc]);
  const bubbles = useMemo(
    () => visibleBubbles(doc, pageBubbleIds(doc, pageNumber)),
    [doc, pageNumber],
  );
  const numbers = useMemo(
    () => new Map(bubbles.map((b, i) => [b.id, i + 1])),
    [bubbles],
  );
  /** Tree order: each panel, then its bubbles, then the bubbles outside every panel. */
  const rows = useMemo<Sel[]>(() => {
    const out: Sel[] = [];
    for (const p of panels) {
      out.push({ kind: "panel", id: p.id });
      for (const b of visibleBubbles(doc, p.bubbleIds))
        out.push({ kind: "bubble", id: b.id });
    }
    for (const b of visibleBubbles(doc, doc.pages[pageNumber]?.looseIds ?? []))
      out.push({ kind: "bubble", id: b.id });
    return out;
  }, [doc, panels, pageNumber]);

  const flagsByPage = useMemo(() => {
    const out = new Map<number, number>();
    for (const f of allFlags) out.set(f.page, (out.get(f.page) ?? 0) + 1);
    return out;
  }, [allFlags]);

  /** True while the document differs from the rows as loaded or last saved. */
  const edited = useMemo(
    () => diffDoc(state.base, doc) !== null,
    [state.base, doc],
  );
  /** What a Save would write now, and how many rows. */
  const pending = useMemo(() => buildSave(state.base, doc), [state.base, doc]);
  const toWrite = useMemo(() => saveCount(pending), [pending]);

  const selBubble = sel?.kind === "bubble" ? doc.bubbles[sel.id] : undefined;
  const selPanel = sel?.kind === "panel" ? doc.panels[sel.id] : undefined;
  const focusPanel = selPanel ?? (selBubble ? panelOf(doc, selBubble) : null);
  const faces = useMemo(
    () => (selBubble && focusPanel ? facesIn(data.faces, focusPanel) : []),
    [data.faces, focusPanel, selBubble],
  );

  const emotions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of data.bubbles) {
      const e = b.emotion.trim().toLowerCase();
      if (e && e.length <= 14 && !e.includes(","))
        counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([e]) => e);
  }, [data.bubbles]);

  // ------------------------------------------------------------- effects

  // Pending edits and undo history go to localStorage a moment after the
  // last change, so typing never waits on a write. A write happens only when
  // the document or the history changed, and only over the revision this tab
  // last read or wrote: another tab's write since then makes this tab stale,
  // and a stale tab never writes again.
  const stateRef = useRef(state);
  const revRef = useRef(boot.rev);
  const writtenRef = useRef(boot.state);
  const staleRef = useRef(false);
  const goStale = useCallback(() => {
    staleRef.current = true;
    setKept("stale");
  }, []);
  const store = useCallback(() => {
    const current = stateRef.current;
    const written = writtenRef.current;
    if (staleRef.current) return;
    if (
      written.doc === current.doc &&
      written.base === current.base &&
      written.past === current.past &&
      written.future === current.future
    )
      return;
    if (storedRev(readRaw(storeKey)) !== revRef.current) {
      goStale();
      return;
    }
    const rev = newId();
    const packed = packState(current, rev);
    // A full store keeps the edits and lets the history go.
    const result: Kept = writeLocal(storeKey, packed)
      ? "kept"
      : writeLocal(storeKey, { ...packed, past: [], future: [] })
        ? "no-history"
        : "failed";
    if (result !== "failed") {
      revRef.current = rev;
      writtenRef.current = current;
    }
    setKept(result);
  }, [storeKey, goStale]);
  useEffect(() => {
    stateRef.current = state;
    const timer = window.setTimeout(store, 250);
    return () => window.clearTimeout(timer);
  }, [state, store]);
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") store();
    };
    window.addEventListener("pagehide", store);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", store);
      document.removeEventListener("visibilitychange", onHide);
      store();
    };
  }, [store]);

  // Another tab wrote this issue's edits: say so at once. The event can
  // arrive after this tab's own later write, so what is stored now decides.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== window.localStorage) return;
      if (e.key !== storeKey && e.key !== null) return;
      if (storedRev(readRaw(storeKey)) !== revRef.current) goStale();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storeKey, goStale]);

  useEffect(() => {
    writeLocal(LAYOUT_KEY, widths);
  }, [widths]);

  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The page lives in the URL too, so a link lands on it.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("page") !== String(pageNumber)) {
      url.searchParams.set("page", String(pageNumber));
      window.history.replaceState(null, "", url);
    }
  }, [pageNumber]);

  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 4200);
    return () => window.clearTimeout(timer);
  }, [note]);

  useEffect(() => {
    if (state.lastHistory) say(state.lastHistory.text);
  }, [state.lastHistory, say]);

  // Neighbouring pages load ahead so a page turn shows art at once.
  useEffect(() => {
    for (const n of [pageNumber + 1, pageNumber - 1]) {
      const next = pagesByNumber.get(n);
      if (next) new window.Image().src = next.imageUrl;
    }
  }, [pageNumber, pagesByNumber]);

  const selId = sel?.id ?? null;
  useEffect(() => {
    setPicker({ open: false, addName: null });
  }, [selId, pageNumber]);

  // Bring the selection into view when it is off screen.
  const selRect = selBubble?.rect ?? selPanel?.rect ?? null;
  const selRectKey = selRect
    ? `${selId}:${selRect.x}:${selRect.y}:${selRect.w}:${selRect.h}`
    : null;
  const selRectRef = useRef(selRect);
  useEffect(() => {
    selRectRef.current = selRect;
  });
  useEffect(() => {
    if (selRectRef.current) canvasRef.current?.reveal(selRectRef.current);
  }, [selRectKey]);

  // ------------------------------------------------------------- actions

  const apply = useCallback(
    (
      label: string,
      recipe: (d: Doc) => Doc,
      opts?: { coalesce?: string; select?: Sel | null; page?: number },
    ) => dispatch({ type: "apply", label, recipe, ...opts }),
    [],
  );

  /** An accepted proposal: every offered field becomes a pending edit, one undo step. */
  const acceptProposal = useCallback(
    (id: string, p: AnalyzeProposal) => {
      apply("accept analyze proposal", (d) => {
        // No speaker from the cast leaves the bubble's speaker as it is.
        const named =
          p.speaker && castById.has(p.speaker)
            ? setSpeaker(d, id, p.speaker)
            : d;
        // No words read leaves the text and its cues as they are, so Save
        // never writes an empty text_with_cues.
        const words =
          p.text && p.textWithCues !== null
            ? { text: p.text, cues: { forText: p.text, value: p.textWithCues } }
            : {};
        return patchBubble(named, id, {
          ...words,
          emotion: p.emotion,
          type: p.type,
        });
      });
      say("Accepted. Save writes it; audio stays a separate step.");
    },
    [apply, castById, say],
  );
  const analyzer = useAnalyze({
    bookId: data.bookId,
    issueId: data.issueId,
    doc,
    cast,
    pagesByNumber,
    busyId,
    onAccept: acceptProposal,
    say,
  });
  const analysisPhases = useMemo(
    () =>
      new Map<string, AnalyzePhase>(
        Object.entries(analyzer.runs).map(([id, run]) => [id, run.phase]),
      ),
    [analyzer.runs],
  );

  const select = useCallback((next: Sel | null) => {
    dispatch({ type: "select", sel: next });
  }, []);

  const goto = useCallback((n: number, next?: Sel | null) => {
    dispatch({ type: "page", page: n, sel: next });
  }, []);

  const turnPage = (dir: -1 | 1) => {
    const index = data.pages.findIndex((p) => p.number === pageNumber);
    const next = data.pages[index + dir];
    if (next) goto(next.number);
  };

  const stepRow = (dir: -1 | 1) => {
    const at = sel
      ? rows.findIndex((r) => r.kind === sel.kind && r.id === sel.id)
      : -1;
    const next = rows[at === -1 ? (dir === 1 ? 0 : rows.length - 1) : at + dir];
    if (next) {
      select(next);
      return;
    }
    // Past the end of the page: carry on into the neighbouring page.
    const index = data.pages.findIndex((p) => p.number === pageNumber);
    const neighbour = data.pages[index + dir];
    if (!neighbour) return;
    const ids = visibleBubbles(doc, pageBubbleIds(doc, neighbour.number));
    const panelIds = doc.pages[neighbour.number]?.panelIds ?? [];
    const firstPanel = panelIds[0];
    const last = ids[ids.length - 1];
    goto(
      neighbour.number,
      dir === 1
        ? firstPanel
          ? { kind: "panel", id: firstPanel }
          : null
        : last
          ? { kind: "bubble", id: last.id }
          : null,
    );
  };

  const stepFlag = (dir: -1 | 1) => {
    if (allFlags.length === 0) {
      say("Nothing needs you.");
      return;
    }
    const order = pageBubbleIds(doc, pageNumber);
    const here = sel?.kind === "bubble" ? order.indexOf(sel.id) : -1;
    const position = (f: (typeof allFlags)[number]) =>
      f.page * 10000 + (f.page === pageNumber ? order.indexOf(f.bubbleId) : 0);
    const current =
      pageNumber * 10000 + (here === -1 ? (dir === 1 ? -1 : 9999) : here);
    const sorted = allFlags.slice().sort((a, b) => position(a) - position(b));
    const next =
      dir === 1
        ? (sorted.find((f) => position(f) > current) ?? sorted[0])
        : (sorted
            .slice()
            .reverse()
            .find((f) => position(f) < current) ?? sorted[sorted.length - 1]);
    if (next) goto(next.page, { kind: "bubble", id: next.bubbleId });
  };

  /** A box drawn with the bubble or the panel tool, or dropped with Shift B (`drawn` false). */
  const drawBox = (rect: Rect, kind: "bubble" | "panel", drawn = true) => {
    const id = newId();
    if (kind === "panel") {
      apply("add panel", (d) => addPanel(d, id, pageNumber, rect), {
        select: { kind: "panel", id },
      });
      const after = addPanel(doc, id, pageNumber, rect);
      const moved = visibleBubbles(after, after.panels[id]?.bubbleIds ?? []);
      say(
        moved.length === 0
          ? "New panel. No bubble sits in it."
          : `New panel. ${plural(moved.length, "bubble")} moved into it.`,
      );
    } else {
      apply("add bubble", (d) => addBubble(d, id, pageNumber, rect), {
        select: { kind: "bubble", id },
      });
      if (drawn) {
        analyzer.arm(id);
        say("New bubble. Analyze starts once the box has been still a second.");
      } else say("New bubble. E types its text, S picks its speaker.");
    }
    setTool("select");
    setRightOpen(true);
  };

  /** Shift B: a box at the panel's centre, not over a balloon yet, so it is not analyzed on its own. */
  const dropBubble = () => {
    const host = focusPanel ?? panels[0];
    const w = 0.14;
    const h = 0.05;
    drawBox(
      host
        ? {
            x: host.rect.x + host.rect.w / 2 - w / 2,
            y: host.rect.y + host.rect.h / 2 - h / 2,
            w,
            h,
          }
        : { x: 0.5 - w / 2, y: 0.5 - h / 2, w, h },
      "bubble",
      false,
    );
  };

  const setRect = (target: Sel, rect: Rect, coalesce?: string) => {
    apply(
      target.kind === "panel" ? "panel box change" : "bubble box change",
      (d) =>
        target.kind === "panel"
          ? setPanelRect(d, target.id, rect)
          : setBubbleRect(d, target.id, rect),
      { coalesce },
    );
    if (target.kind === "bubble") analyzer.moved(target.id, rect);
  };

  /**
   * Delete bubbles, or dismiss them as duplicates: the same removal. The
   * selection lands on the next bubble (the next flagged one after a
   * dismiss), so D, D, D clears a page of duplicates.
   */
  const removeBubbles = (ids: string[], how: "delete" | "dismiss") => {
    const all = pageBubbleIds(doc, pageNumber);
    const rest = all.filter(
      (id) =>
        !ids.includes(id) &&
        doc.bubbles[id]?.deleted === false &&
        (how === "delete" || flags.has(id)),
    );
    const from = sel?.kind === "bubble" ? all.indexOf(sel.id) : -1;
    const next =
      rest.find((id) => all.indexOf(id) > from) ??
      (how === "delete" ? rest[rest.length - 1] : rest[0]) ??
      null;
    apply(
      how === "delete"
        ? "delete bubble"
        : ids.length === 1
          ? "dismiss duplicate"
          : `dismiss ${ids.length} duplicates`,
      (d) => setDeleted(d, ids, true),
      {
        select:
          sel?.kind === "bubble" && ids.includes(sel.id)
            ? next
              ? { kind: "bubble", id: next }
              : null
            : sel,
      },
    );
    say(
      how === "delete"
        ? "Deleted. It stays under Deleted bubbles in the tree, and Cmd Z brings it back."
        : ids.length === 1
          ? "Dismissed. It stays under Deleted bubbles in the tree."
          : `Dismissed ${ids.length} duplicates.`,
    );
  };

  const deletePanel = (id: string) => {
    const panel = doc.panels[id];
    if (!panel) return;
    const number = panels.findIndex((p) => p.id === id) + 1;
    const count = visibleBubbles(doc, panel.bubbleIds).length;
    apply("delete panel", (d) => removePanel(d, id), { select: null });
    say(
      count > 0
        ? `Deleted panel ${number}. Its ${plural(count, "bubble")} moved to the panel each overlaps most, or outside every panel.`
        : `Deleted panel ${number}.`,
    );
  };

  /**
   * Write every pending edit in one request. The editor stays as it is: on
   * success the document that was sent becomes the baseline, and nothing
   * else changes; on failure the edits stay pending and the error shows.
   * Resolves to the document that is now saved, or why nothing was.
   */
  const savingRef = useRef(false);
  const save = async (): Promise<
    { ok: true; sent: Doc } | { ok: false; error: string }
  > => {
    if (savingRef.current)
      return {
        ok: false,
        error: "A Save is already running. Try again once it finishes.",
      };
    // A regenerate in flight reads or writes the row as saved; a Save landing
    // under it would pair its result with other text.
    if (listen.isWriting()) {
      const error =
        "A regenerate is running. Save again once it finishes; your edits stay pending.";
      say(error, "warn");
      return { ok: false, error };
    }
    const sent = state.doc;
    const edits = buildSave(state.base, sent);
    const count = saveCount(edits);
    if (count === 0) {
      say("Nothing to save.");
      return { ok: true, sent };
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/apply-fixes/save", {
        method: "POST",
        // Basic auth: the browser's session for this origin carries the
        // credentials, so no secret goes in the client bundle.
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bookId: data.bookId,
          issueId: data.issueId,
          ...edits,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | (Partial<SaveResult> & { error?: string })
        | null;
      if (!res.ok) {
        const error =
          body?.error ??
          `Nothing was saved: the server answered ${res.status}.`;
        setSaveError(error);
        return { ok: false, error };
      }
      dispatch({ type: "saved", base: sent });
      listen.dropTakes(takesDropped(edits));
      const audio = body?.needsAudio ?? 0;
      say(
        audio > 0
          ? `Saved ${plural(count, "change")}. ${plural(audio, "bubble")} now need${audio === 1 ? "s" : ""} audio.`
          : `Saved ${plural(count, "change")}.`,
      );
      return { ok: true, sent };
    } catch (e) {
      // No answer: the request may or may not have reached the database.
      const error = `The save may or may not have landed (${(e as Error).message}). Your edits are still here; reload the editor to see the rows as they are now.`;
      setSaveError(error);
      return { ok: false, error };
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  /** The bubble's row is in the database: the baseline holds it, not deleted. */
  const saved = (id: string) => {
    const row = state.base.bubbles[id];
    return !!row && !row.deleted;
  };
  /** A Save would write this bubble's row. */
  const hasPending = (id: string) =>
    [...pending.bubbles.add, ...pending.bubbles.update].some(
      (row) => row.id === id,
    );

  /**
   * Before a regenerate: when the bubble has a pending edit, part 2's Save
   * writes every pending edit, and the regenerate runs only once it lands.
   */
  const saveFirst = async (id: string): Promise<SavedRow> => {
    const row = state.base.bubbles[id];
    if (!row || row.deleted)
      return { ok: false, error: "This bubble has no saved row yet." };
    if (!hasPending(id)) return { ok: true, text: row.text };
    const res = await save();
    if (!res.ok) return res;
    return { ok: true, text: res.sent.bubbles[id]?.text ?? row.text };
  };
  const listen = useListen({
    bookId: data.bookId,
    issueId: data.issueId,
    bubbles: data.bubbles,
    selectedId: sel?.id ?? null,
    saveFirst,
    onCues: (id, forText, value) =>
      dispatch({ type: "cuesWritten", id, cues: { forText, value } }),
  });
  // A bubble with a saved row that is spoken aloud gets the audio controls.
  const listenView: ListenView | null =
    selBubble && saved(selBubble.id) && !selBubble.silent && !selBubble.ignored
      ? {
          hasAudio: !!listen.paths[selBubble.id],
          playing: listen.playing === selBubble.id,
          run: listen.runs[selBubble.id],
          saveFirst: hasPending(selBubble.id) ? toWrite : 0,
          saveBlocked: listen.writing,
        }
      : null;

  const discard = () => {
    setConfirmDiscard(false);
    // A stale tab must not clear what another tab stored.
    if (staleRef.current) return;
    if (storedRev(readRaw(storeKey)) !== revRef.current) {
      goStale();
      return;
    }
    clearLocal(storeKey);
    revRef.current = null;
    dispatch({ type: "discard" });
    say("Edits discarded. Back to the rows as loaded.");
  };

  const openField = (
    field: "text" | "emotion" | "speaker",
    addName?: string,
  ) => {
    if (!selBubble) return;
    setRightOpen(true);
    if (field === "speaker") {
      setPicker({ open: true, addName: addName ?? null });
      return;
    }
    const focus = () => {
      // Text keeps what is there, caret at the end; the short emotion is replaced.
      if (field === "text") {
        const el = textRef.current;
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
        return;
      }
      emotionRef.current?.focus();
      emotionRef.current?.select();
    };
    // An open drawer takes the focus at once, so the next key lands in the
    // field; a folded one has to render first.
    if (rightOpen) focus();
    else window.requestAnimationFrame(focus);
  };

  const actions: Actions = {
    select,
    patch: (id, patch, label, coalesce) =>
      apply(label, (d) => patchBubble(d, id, patch), { coalesce }),
    setSpeaker: (id, castId) => {
      apply("speaker change", (d) => setSpeaker(d, id, castId));
      setPicker({ open: false, addName: null });
    },
    addCast: (name, voice, knownId, bubbleId, raw) => {
      const row = knownId ? data.known.find((k) => k.id === knownId) : null;
      setPicker({ open: false, addName: null });
      // A name that already names someone in the cast picks that entry; it
      // never becomes a second one.
      const existing =
        (row ? castById.get(row.id) : undefined) ?? findCast(name, cast);
      if (existing) {
        apply("speaker change", (d) => setSpeaker(d, bubbleId, existing.id));
        say(`${existing.name} is already in the cast.`);
        return;
      }
      // A known character keeps its `characters` id and display name.
      const id = row?.id ?? (slug(name) || "character");
      const display = row?.name ?? name;
      const voiceName =
        voice.kind === "new" ? "" : (voiceById.get(voice.voiceId)?.name ?? "");
      // The form says "Another voice" when the character has its own, and
      // "Borrow" when it has none.
      const hasOwn = ownVoice(name, data.known, data.voices) !== null;
      const single = raw && !/,|&|\/|\band\b/i.test(raw) ? raw : undefined;
      apply("add character", (d) =>
        setSpeaker(
          addCast(d, { id, name: display, voice }, single),
          bubbleId,
          id,
        ),
      );
      say(
        voice.kind === "new"
          ? `${display} joins the cast with a new voice, made in a later step.`
          : voice.kind === "own"
            ? `${display} joins the cast with the voice ${voiceName}.`
            : hasOwn
              ? `${display} joins the cast with another voice, ${voiceName}.`
              : `${display} joins the cast, borrowing the voice ${voiceName}.`,
      );
    },
    openPicker: (addName) => openField("speaker", addName),
    closePicker: () => setPicker({ open: false, addName: null }),
    dismiss: (ids) => removeBubbles(ids, "dismiss"),
    keep: (id) => apply("keep both", (d) => patchBubble(d, id, { kept: true })),
    deleteBubble: (id) => removeBubbles([id], "delete"),
    deletePanel,
    moveToPanel: (id, panelId) =>
      apply("move to panel", (d) => moveBubbleToPanel(d, id, panelId)),
    shift: (target, dir) =>
      apply(dir === -1 ? "move earlier" : "move later", (d) =>
        target.kind === "panel"
          ? shiftPanel(d, target.id, dir)
          : shiftBubble(d, target.id, dir),
      ),
    setRect,
    zoomTo: (rect) => canvasRef.current?.zoomTo(rect),
    goto,
    analyze: analyzer.analyze,
    accept: analyzer.accept,
    setHint: analyzer.setHint,
    play: listen.play,
    regenerate: (id, job) => void listen.regenerate(id, job),
  };

  const toggleRail = (view: LeftView) => {
    if (view === leftView) setLeftOpen((v) => !v);
    else {
      setLeftView(view);
      setLeftOpen(true);
    }
  };

  // ------------------------------------------------------------ keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT");
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      if (mod && key === "s") {
        // Keep the browser's save dialog shut, in a text field too.
        e.preventDefault();
        if (!confirmDiscard) void save();
        return;
      }
      if (confirmDiscard) {
        if (key === "Escape") setConfirmDiscard(false);
        return;
      }
      if (mod && key === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
        return;
      }
      if (mod) return;
      if (sheet) {
        if (key === "Escape" || key === "?") setSheet(false);
        return;
      }
      // Inside the picker, the add form or any other popover, single keys
      // belong to it, on a focused button there as much as in a field.
      if (t?.closest("[data-popover]")) return;
      // A text field keeps every key but Escape, Delete and Backspace included.
      if (typing) {
        if (key === "Escape") t.blur();
        return;
      }

      const done = () => e.preventDefault();
      const arrow =
        key === "ArrowUp"
          ? [0, -1]
          : key === "ArrowDown"
            ? [0, 1]
            : key === "ArrowLeft"
              ? [-1, 0]
              : key === "ArrowRight"
                ? [1, 0]
                : null;

      if (arrow && e.shiftKey && sel && selRect) {
        // Nudge: Shift moves the box, Alt+Shift resizes it.
        const step = 0.0025;
        const dx = (arrow[0] ?? 0) * step;
        const dy = (arrow[1] ?? 0) * step;
        setRect(
          sel,
          e.altKey
            ? { ...selRect, w: selRect.w + dx, h: selRect.h + dy }
            : { ...selRect, x: selRect.x + dx, y: selRect.y + dy },
          `nudge:${sel.id}`,
        );
        return done();
      }
      if (arrow && e.altKey && sel && arrow[1] !== 0) {
        actions.shift(sel, arrow[1] === -1 ? -1 : 1);
        return done();
      }
      if (e.altKey) return;

      switch (key) {
        case "?":
          setSheet(true);
          return done();
        case "Escape":
          if (picker.open) setPicker({ open: false, addName: null });
          else if (tool !== "select") setTool("select");
          else select(null);
          return done();
        case "ArrowDown":
        case "j":
          stepRow(1);
          return done();
        case "ArrowUp":
        case "k":
          stepRow(-1);
          return done();
        case "ArrowRight":
        case "]":
        case "PageDown":
          turnPage(1);
          return done();
        case "ArrowLeft":
        case "[":
        case "PageUp":
          turnPage(-1);
          return done();
        case "n":
          stepFlag(e.shiftKey ? -1 : 1);
          return done();
        case "b":
          if (e.shiftKey) dropBubble();
          else setTool((prev) => (prev === "bubble" ? "select" : "bubble"));
          return done();
        case "p":
          setTool((prev) => (prev === "panel" ? "select" : "panel"));
          return done();
        case "v":
          setTool("select");
          return done();
        case "f":
          setOnlyFlagged((v) => !v);
          return done();
        case ",":
          setLeftOpen((v) => !v);
          return done();
        case ".":
          setRightOpen((v) => !v);
          return done();
        case "0":
          canvasRef.current?.fit();
          return done();
        case "+":
        case "=":
          canvasRef.current?.zoomBy(1.25);
          return done();
        case "-":
          canvasRef.current?.zoomBy(0.8);
          return done();
        case "z":
          if (focusPanel) canvasRef.current?.zoomTo(focusPanel.rect);
          return done();
        case "Delete":
        case "Backspace":
          if (selBubble) removeBubbles([selBubble.id], "delete");
          else if (selPanel) deletePanel(selPanel.id);
          return done();
        case " ":
          return done();
      }

      if (!selBubble) return;
      const b = selBubble;
      const proposed = analyzer.runs[b.id]?.phase === "ready";
      switch (key) {
        case "Enter":
          if (proposed) analyzer.accept(b.id);
          else openField("text");
          return done();
        case "r":
          if (proposed) analyzer.analyze(b.id);
          return done();
        case "l":
          if (listenView?.hasAudio) listen.play(b.id);
          return done();
        case "e":
          openField("text");
          return done();
        case "s":
          openField("speaker");
          return done();
        case "m":
          openField("emotion");
          return done();
        case "x":
          actions.patch(
            b.id,
            { silent: !b.silent },
            b.silent ? "unmark silent" : "mark silent",
          );
          return done();
        case "i":
          actions.patch(
            b.id,
            { ignored: !b.ignored },
            b.ignored ? "unmark ignored" : "mark ignored",
          );
          return done();
        case "d":
          if (flags.get(b.id)?.some((f) => f.kind === "duplicate"))
            removeBubbles([b.id], "dismiss");
          else
            say(
              "Not flagged as a duplicate. Delete removes any bubble.",
              "warn",
            );
          return done();
        case "y":
          if (flags.get(b.id)?.some((f) => f.kind === "duplicate"))
            actions.keep(b.id);
          return done();
      }
      const type = TYPE_KEYS[key];
      if (type) {
        actions.patch(b.id, { type }, "type change");
        return done();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // -------------------------------------------------------------- render

  if (!page) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950 text-[13px] text-neutral-400">
        This issue has no pages.
      </div>
    );
  }

  const notKept = kept === "failed" || kept === "stale";
  // The drawers give way before the canvas drops under its minimum.
  const room = viewport - RAIL_WIDTH - CANVAS_MIN;
  const rightWidth = rightOpen
    ? clampWidth(widths.right, {
        min: RIGHT.min,
        max: Math.max(RIGHT.min, room - (leftOpen ? LEFT.min : 0)),
      })
    : 0;
  const leftWidth = leftOpen
    ? clampWidth(widths.left, {
        min: LEFT.min,
        max: Math.max(LEFT.min, room - rightWidth),
      })
    : 0;

  const duplicateSelected =
    !!selBubble &&
    !!flags.get(selBubble.id)?.some((f) => f.kind === "duplicate");
  const proposalShown =
    !!selBubble && analyzer.runs[selBubble.id]?.phase === "ready";
  const hints: [string, string][] = selBubble
    ? [
        ...(proposalShown
          ? ([
              ["Enter", "accept"],
              ["R", "try again"],
            ] as [string, string][])
          : []),
        ...(listenView?.hasAudio
          ? ([["L", listenView.playing ? "stop" : "play"]] as [
              string,
              string,
            ][])
          : []),
        ["↑↓", "step"],
        ["S", "speaker"],
        ["E", "text"],
        ["X", "silent"],
        ...(duplicateSelected
          ? ([
              ["D", "dismiss"],
              ["Y", "keep"],
            ] as [string, string][])
          : []),
        ["Del", "delete"],
        ["N", "next flag"],
      ]
    : selPanel
      ? [
          ["↑↓", "step"],
          ["Alt ↑↓", "reorder"],
          ["Z", "zoom to panel"],
          ["Shift B", "drop a bubble"],
          ["Del", "delete"],
        ]
      : [
          ["↓", "first panel"],
          ["N", "next flag"],
          ["B", "draw a bubble"],
          ["P", "draw a panel"],
          ["← →", "pages"],
        ];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-neutral-950 text-[12px] text-neutral-200">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-neutral-800 px-3">
        <nav className="flex min-w-0 items-center gap-1.5 text-neutral-500">
          <Link href="/admin" className="hover:text-neutral-100">
            Admin
          </Link>
          <span>/</span>
          <Link
            href={`/admin/${data.bookId}/${data.issueId}/review/pipeline`}
            className="truncate hover:text-neutral-100"
          >
            {data.bookName}, {data.issueName}
          </Link>
          <span>/</span>
          <span className="shrink-0 text-neutral-100">Review editor</span>
        </nav>

        <div className="flex shrink-0 overflow-hidden rounded-sm border border-neutral-800">
          {TOOLS.map(([id, label, k]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tool === id}
              onClick={() => setTool(id)}
              className={`flex h-6 items-center gap-1.5 px-2 ${
                tool === id
                  ? "bg-neutral-200 text-neutral-950"
                  : "text-neutral-400 hover:text-neutral-100"
              }`}
            >
              {label}
              <span className="text-neutral-600">{k}</span>
            </button>
          ))}
        </div>

        <span className="flex-1" />

        <button
          type="button"
          onClick={() => stepFlag(1)}
          className={`flex h-6 shrink-0 items-center gap-1.5 rounded-sm border px-2 ${
            allFlags.length > 0
              ? "border-amber-400/50 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20"
              : "border-neutral-800 text-emerald-300"
          }`}
        >
          {allFlags.length > 0 ? (
            <>
              {needYou(allFlags.length)}
              <span className="text-amber-200/60">
                {flags.size} on this page
              </span>
              <Key>N</Key>
            </>
          ) : (
            "Nothing needs you"
          )}
        </button>
        <button
          type="button"
          disabled={state.past.length === 0}
          onClick={() => dispatch({ type: "undo" })}
          className={BAR_BUTTON}
          title="Undo (Cmd Z)"
        >
          Undo
          {state.past.length > 0 && (
            <span className="text-neutral-500 tabular-nums">
              {state.past.length}
            </span>
          )}
        </button>
        <button
          type="button"
          disabled={state.future.length === 0}
          onClick={() => dispatch({ type: "redo" })}
          className={BAR_BUTTON}
          title="Redo (Shift Cmd Z)"
        >
          Redo
        </button>
        {(edited || notKept) && (
          <span
            role="status"
            className={`shrink-0 rounded-sm px-1 ${
              notKept ? "text-amber-300" : "text-neutral-500"
            }`}
          >
            {notKept
              ? "Edits are not being kept"
              : kept === "no-history"
                ? "Edits are kept in this browser, the undo history is not"
                : "Edits are kept in this browser"}
          </span>
        )}
        {edited && kept !== "stale" && (
          <button
            type="button"
            onClick={() => setConfirmDiscard(true)}
            className={BAR_BUTTON}
          >
            Discard edits
          </button>
        )}
        <button
          type="button"
          disabled={saving || toWrite === 0 || listen.writing}
          onClick={() => void save()}
          title={
            listen.writing
              ? "Save waits until the regenerate finishes"
              : "Save every pending edit (Cmd S)"
          }
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-sm bg-neutral-100 px-2 font-medium text-neutral-950 hover:bg-white disabled:bg-neutral-800 disabled:font-normal disabled:text-neutral-500"
        >
          {saving ? "Saving" : "Save"}
          {toWrite > 0 && !saving && (
            <span className="tabular-nums opacity-60">{toWrite}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setSheet(true)}
          className={BAR_BUTTON}
        >
          Keys <span className="text-neutral-500">?</span>
        </button>
      </header>

      {saveError && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-red-400/40 bg-red-500/10 px-3 py-1.5 text-red-200"
        >
          <span className="flex-1">{saveError}</span>
          <button
            type="button"
            onClick={() => setSaveError(null)}
            className="h-6 shrink-0 rounded-sm border border-red-400/50 px-2 hover:bg-red-500/20"
          >
            Dismiss
          </button>
        </div>
      )}

      {(kept !== "kept" || notices.length > 0) && (
        <div className="shrink-0 border-b border-amber-400/40 bg-amber-400/10 text-amber-200">
          {kept === "stale" && (
            <div role="alert" className="flex items-center gap-3 px-3 py-1.5">
              <span className="flex-1">
                This issue was edited in another tab. Nothing done here is being
                kept. Reload to pick up the edits from the other tab.
              </span>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="h-6 shrink-0 rounded-sm bg-amber-300 px-2 font-medium text-neutral-950 hover:bg-amber-200"
              >
                Reload
              </button>
            </div>
          )}
          {kept === "failed" && (
            <div role="alert" className="px-3 py-1.5">
              This browser refused to store the edits (its storage is full or
              blocked). They are lost when this tab closes or reloads.
            </div>
          )}
          {kept === "no-history" && (
            <div role="status" className="px-3 py-1.5">
              The undo history no longer fits in this browser&apos;s storage.
              The edits are kept; undo will not survive a reload.
            </div>
          )}
          {notices.map((text) => (
            <div
              key={text}
              role="status"
              className="flex items-center gap-3 px-3 py-1.5"
            >
              <span className="flex-1">{text}</span>
              <button
                type="button"
                onClick={() =>
                  setNotices((list) => list.filter((n) => n !== text))
                }
                className="h-6 shrink-0 rounded-sm border border-amber-400/50 px-2 hover:bg-amber-400/20"
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Left drawer"
          className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-neutral-800 py-1.5"
        >
          {RAIL.map((entry) => {
            const shown = leftOpen && leftView === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                tabIndex={-1}
                aria-pressed={shown}
                aria-label={entry.label}
                title={`${entry.label} (,)`}
                onClick={() => toggleRail(entry.id)}
                className={`flex size-7 items-center justify-center rounded-sm ${
                  shown
                    ? "bg-neutral-800 text-white"
                    : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
                }`}
              >
                <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
                  <path
                    d={entry.icon}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            );
          })}
        </nav>

        {leftOpen && (
          <aside
            className="relative flex shrink-0 flex-col border-r border-neutral-800"
            style={{ width: leftWidth }}
          >
            <ResizeHandle
              drawer="left"
              width={leftWidth}
              limits={{
                min: LEFT.min,
                max: Math.max(LEFT.min, Math.min(LEFT.max, room - rightWidth)),
              }}
              onResize={(left) => setWidths((w) => ({ ...w, left }))}
            />
            {leftView === "order" && (
              <>
                <section className="shrink-0 border-b border-neutral-800">
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-expanded={pagesOpen}
                    onClick={() => setPagesOpen((v) => !v)}
                    className="flex h-8 w-full items-center gap-1.5 px-2 text-[11px] text-neutral-500 hover:text-neutral-300"
                  >
                    <svg viewBox="0 0 8 8" className="size-2" aria-hidden>
                      <path
                        d={pagesOpen ? "M1 2l3 4 3-4z" : "M2 1l4 3-4 3z"}
                        fill="currentColor"
                      />
                    </svg>
                    <span>Pages</span>
                    <span className="flex-1" />
                    <span className="tabular-nums">
                      Page {pageNumber} of {data.pages.length}
                    </span>
                  </button>
                  {pagesOpen && (
                    <div className="flex max-h-[40vh] flex-wrap gap-1 overflow-y-auto px-2 pb-2">
                      {data.pages.map((p) => {
                        const count = flagsByPage.get(p.number) ?? 0;
                        const current = p.number === pageNumber;
                        return (
                          <button
                            key={p.number}
                            type="button"
                            tabIndex={-1}
                            aria-current={current ? "page" : undefined}
                            onClick={() => goto(p.number)}
                            title={
                              count > 0
                                ? `Page ${p.number}: ${needYou(count)}`
                                : `Page ${p.number}`
                            }
                            className={`relative h-6 w-6 rounded-sm border text-[11px] tabular-nums ${
                              current
                                ? "border-neutral-100 bg-neutral-100 font-medium text-neutral-950"
                                : count > 0
                                  ? "border-amber-400/50 text-amber-200 hover:border-amber-300"
                                  : "border-neutral-800 text-neutral-400 hover:border-neutral-500"
                            }`}
                          >
                            {p.number}
                            {count > 0 && (
                              <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-amber-400" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>
                <div className="flex h-8 shrink-0 items-center gap-2 border-b border-neutral-800 px-2 text-[11px] text-neutral-500">
                  <span className="truncate">
                    Reading order. Drag to reorder.
                  </span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    aria-pressed={onlyFlagged}
                    onClick={() => setOnlyFlagged((v) => !v)}
                    className={`shrink-0 rounded-sm px-1.5 leading-5 ${
                      onlyFlagged
                        ? "bg-amber-400 text-neutral-950"
                        : "text-neutral-400 hover:text-neutral-100"
                    }`}
                  >
                    Needs you only <span className="opacity-60">F</span>
                  </button>
                </div>
                <Tree
                  doc={doc}
                  pageNumber={pageNumber}
                  panels={panels}
                  flags={flags}
                  numbers={numbers}
                  castById={castById}
                  sel={sel}
                  hover={hover}
                  onlyFlagged={onlyFlagged}
                  onSelect={select}
                  onHover={setHover}
                  onMoveBubble={(id, panelId, index) =>
                    apply(
                      "reorder bubble",
                      (d) => moveBubbleTo(d, id, panelId, index),
                      { select: { kind: "bubble", id } },
                    )
                  }
                  onMovePanel={(id, index) =>
                    apply("reorder panel", (d) => movePanelTo(d, id, index), {
                      select: { kind: "panel", id },
                    })
                  }
                  onDismiss={(id) => removeBubbles([id], "dismiss")}
                  onRestore={(id) =>
                    apply("restore bubble", (d) => setDeleted(d, [id], false), {
                      select: { kind: "bubble", id },
                    })
                  }
                  onZoomPanel={(id) => {
                    const p = doc.panels[id];
                    if (p) canvasRef.current?.zoomTo(p.rect);
                  }}
                />
              </>
            )}
          </aside>
        )}

        <main className="relative min-w-0 flex-1">
          <Canvas
            ref={canvasRef}
            page={page}
            panels={panels}
            bubbles={bubbles}
            numbers={numbers}
            flags={flags}
            castById={castById}
            faces={faces}
            sel={sel}
            hover={hover}
            tool={tool}
            onSelect={select}
            onHover={setHover}
            onCommitRect={(target, rect) => setRect(target, rect)}
            onDraw={(rect) =>
              drawBox(rect, tool === "panel" ? "panel" : "bubble")
            }
            onPickFace={(characterId) => {
              if (selBubble) actions.setSpeaker(selBubble.id, characterId);
            }}
            onZoom={setZoom}
            analysis={analysisPhases}
            onBusy={setBusyId}
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setRightOpen((v) => !v)}
            title={rightOpen ? "Fold the fields (.)" : "Show the fields (.)"}
            aria-label={rightOpen ? "Fold the fields" : "Show the fields"}
            className={`absolute top-2 right-2 flex size-6 items-center justify-center hover:text-white ${FLOAT}`}
          >
            <Chevron dir={rightOpen ? "right" : "left"} />
          </button>
          {tool !== "select" && (
            <div
              className={`pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 px-2 py-1 text-neutral-200 ${FLOAT}`}
            >
              {DRAW_HINT[tool]}
            </div>
          )}
          {note && (
            <div
              role="status"
              className={`pointer-events-none absolute bottom-3 left-1/2 max-w-[70%] -translate-x-1/2 rounded-sm border px-3 py-1.5 text-center ${
                note.tone === "warn"
                  ? "border-amber-400/60 bg-neutral-950 text-amber-200"
                  : "border-neutral-600 bg-neutral-950 text-neutral-100"
              }`}
            >
              {note.text}
            </div>
          )}
          <div
            role="group"
            aria-label="Zoom"
            className={`absolute right-2 bottom-2 flex h-7 items-center gap-0.5 px-1 ${FLOAT}`}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-label="Zoom out"
              title="Zoom out (-)"
              onClick={() => canvasRef.current?.zoomBy(0.8)}
              className="size-5 rounded-sm hover:bg-neutral-800 hover:text-white"
            >
              -
            </button>
            <span className="w-9 text-center text-neutral-300 tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              tabIndex={-1}
              aria-label="Zoom in"
              title="Zoom in (+)"
              onClick={() => canvasRef.current?.zoomBy(1.25)}
              className="size-5 rounded-sm hover:bg-neutral-800 hover:text-white"
            >
              +
            </button>
            <button
              type="button"
              tabIndex={-1}
              title="Fit the page (0)"
              onClick={() => canvasRef.current?.fit()}
              className="rounded-sm px-1.5 leading-5 hover:bg-neutral-800 hover:text-white"
            >
              Fit
            </button>
          </div>
        </main>

        {rightOpen && (
          <aside
            className="relative shrink-0 border-l border-neutral-800"
            style={{ width: rightWidth }}
          >
            <ResizeHandle
              drawer="right"
              width={rightWidth}
              limits={{
                min: RIGHT.min,
                max: Math.max(RIGHT.min, Math.min(RIGHT.max, room - leftWidth)),
              }}
              onResize={(right) => setWidths((w) => ({ ...w, right }))}
            />
            <div className="h-full overflow-y-auto">
              <Inspector
                data={data}
                doc={doc}
                page={page}
                sel={sel}
                panels={panels}
                flags={flags}
                allFlags={allFlags}
                numbers={numbers}
                cast={cast}
                castById={castById}
                pagesByNumber={pagesByNumber}
                picker={picker}
                emotions={emotions}
                textRef={textRef}
                emotionRef={emotionRef}
                analysis={analyzer.runs}
                hints={analyzer.hints}
                listen={listenView}
                actions={actions}
              />
            </div>
          </aside>
        )}
      </div>

      {/* Key hints only. The left pad keeps them clear of the Next.js dev badge. */}
      <footer className="flex h-7 shrink-0 items-center gap-2.5 border-t border-neutral-800 pr-3 pl-16 text-[11px] text-neutral-500">
        {hints.map(([k, label]) => (
          <span key={k} className="flex items-center gap-1">
            <Key>{k}</Key>
            {label}
          </span>
        ))}
      </footer>

      {confirmDiscard && (
        <div
          role="alertdialog"
          data-popover
          aria-label="Discard edits"
          className="absolute inset-0 z-50 flex items-center justify-center bg-neutral-950/80"
          onClick={() => setConfirmDiscard(false)}
        >
          <div
            className="w-[400px] max-w-[94vw] space-y-3 rounded border border-neutral-700 bg-neutral-900 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-[13px] font-medium text-neutral-100">
              Discard every edit to this issue?
            </h2>
            <p className="text-neutral-400">
              This clears the edits and the undo history this browser holds for{" "}
              {data.bookName}, {data.issueName}. The editor goes back to the
              rows as loaded.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDiscard(false)}
                className={BAR_BUTTON}
              >
                Keep editing <span className="text-neutral-500">Esc</span>
              </button>
              <button
                type="button"
                autoFocus
                onClick={discard}
                className="flex h-6 items-center rounded-sm bg-neutral-100 px-2.5 font-medium text-neutral-950 hover:bg-white"
              >
                Discard edits
              </button>
            </div>
          </div>
        </div>
      )}

      {sheet && (
        <div
          role="dialog"
          data-popover
          aria-label="Keyboard shortcuts"
          className="absolute inset-0 z-50 flex items-center justify-center bg-neutral-950/80"
          onClick={() => setSheet(false)}
        >
          <div
            className="max-h-[86vh] w-[860px] max-w-[94vw] overflow-y-auto rounded border border-neutral-700 bg-neutral-900 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center">
              <h2 className="text-[13px] font-medium text-neutral-100">Keys</h2>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setSheet(false)}
                className={BAR_BUTTON}
              >
                Close <span className="text-neutral-500">Esc</span>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-3">
              {SHEET.map((group) => (
                <section key={group.title}>
                  <h3 className="mb-1.5 text-[11px] tracking-wide text-neutral-500 uppercase">
                    {group.title}
                  </h3>
                  <dl className="space-y-1">
                    {group.rows.map(([k, label]) => (
                      <div key={k} className="flex items-baseline gap-2">
                        <dt className="w-[92px] shrink-0 text-neutral-100">
                          {k}
                        </dt>
                        <dd className="text-neutral-400">{label}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
