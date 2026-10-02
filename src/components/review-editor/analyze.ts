// Analyze in the editor: a drawn bubble asks once its box has been still for a second, Analyze again asks on demand, and a proposal waits for Accept.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyzeBubble,
  type AnalyzeProposal,
  type AnalyzeResult,
} from "~/server/actions/review/analyze-bubble";
import { clampRect, type Doc } from "./model";
import type { CastMember, Rect, SrcPage } from "./types";

export type AnalyzePhase = "waiting" | "running" | "ready" | "failed";

export interface AnalyzeRun {
  phase: AnalyzePhase;
  /**
   * Drawn in the editor: it asks on its own once the box is still, and asks
   * again if the box moves before the answer is back. Once a proposal or an
   * error shows, a move keeps it; Try again and Analyze again ask anew.
   */
  auto: boolean;
  /** The request this run waits on. A reply to any other is dropped. */
  token: number;
  /** The box the request was cut from. */
  sent: string | null;
  proposal: AnalyzeProposal | null;
  error: string | null;
}

/** How long a drawn box stays still before it is analyzed. */
const SETTLE_MS = 1000;
/** The crop's longest side, so it stays well under the 1 MB action limit. */
const CROP_MAX = 1024;
/** Room around the box, as a share of it, so the tail shows. */
const CROP_PAD = 0.06;

const rectKey = (r: Rect) => `${r.x}:${r.y}:${r.w}:${r.h}`;

const images = new Map<string, Promise<HTMLImageElement>>();

/** The page image, loaded once per URL with CORS so a canvas may read it. */
function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = images.get(url);
  if (cached) return cached;
  const loading = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error("the page image did not load for the crop"));
    img.src = url;
  });
  images.set(url, loading);
  loading.catch(() => images.delete(url));
  return loading;
}

/** The box cut from the page as a JPEG, and the box in page pixels. */
async function cutBox(url: string, rect: Rect) {
  const img = await loadImage(url);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const box = {
    x: rect.x * W,
    y: rect.y * H,
    width: rect.w * W,
    height: rect.h * H,
  };
  const sx = Math.max(0, Math.floor(box.x - box.width * CROP_PAD));
  const sy = Math.max(0, Math.floor(box.y - box.height * CROP_PAD));
  const sw = Math.min(W - sx, Math.ceil(box.width * (1 + CROP_PAD * 2)));
  const sh = Math.min(H - sy, Math.ceil(box.height * (1 + CROP_PAD * 2)));
  const scale = Math.min(1, CROP_MAX / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser cannot cut the crop");
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return { crop: canvas.toDataURL("image/jpeg", 0.85), box };
}

interface UseAnalyzeArgs {
  bookId: string;
  issueId: string;
  doc: Doc;
  cast: CastMember[];
  pagesByNumber: Map<number, SrcPage>;
  /** A bubble whose box is being dragged: its wait does not run out mid-drag. */
  busyId: string | null;
  /** Turn an accepted proposal into pending edits. */
  onAccept: (id: string, proposal: AnalyzeProposal) => void;
  say: (text: string, tone?: "plain" | "warn") => void;
}

export function useAnalyze({
  bookId,
  issueId,
  doc,
  cast,
  pagesByNumber,
  busyId,
  onAccept,
  say,
}: UseAnalyzeArgs) {
  const [runs, setRuns] = useState<Record<string, AnalyzeRun>>({});
  const [hints, setHints] = useState<Record<string, string>>({});
  // Replies land long after the render that asked, so they read the latest
  // of everything through refs. `runsRef` is the source of truth for runs.
  const runsRef = useRef(runs);
  const docRef = useRef(doc);
  const castRef = useRef(cast);
  const pagesRef = useRef(pagesByNumber);
  const hintsRef = useRef(hints);
  const sayRef = useRef(say);
  useEffect(() => {
    docRef.current = doc;
    castRef.current = cast;
    pagesRef.current = pagesByNumber;
    hintsRef.current = hints;
    sayRef.current = say;
  });
  const tokenRef = useRef(0);

  const put = useCallback((id: string, run: AnalyzeRun | null) => {
    const next = { ...runsRef.current };
    if (run) next[id] = run;
    else delete next[id];
    runsRef.current = next;
    setRuns(next);
  }, []);

  // A box dragged while its request is out: the drag's rect lives in the
  // canvas until pointer-up, so the committed rect alone cannot show it.
  // Holds the token of the request each such box had out.
  const busyRef = useRef(busyId);
  const draggedRef = useRef(new Map<string, number>());
  useEffect(() => {
    busyRef.current = busyId;
    if (!busyId) return;
    const run = runsRef.current[busyId];
    if (run?.phase === "running") draggedRef.current.set(busyId, run.token);
  }, [busyId]);

  /**
   * The running run a request belongs to, while that request still stands
   * for the box as it is. Otherwise null, with the run put where it belongs:
   * gone with its bubble, or, for a box that moved, back to waiting (drawn)
   * or dropped with a note (Analyze again).
   */
  const current = useCallback(
    (id: string, token: number, sent: string): AnalyzeRun | null => {
      const run = runsRef.current[id];
      if (run?.phase !== "running" || run.token !== token) return null;
      const bubble = docRef.current.bubbles[id];
      if (!bubble || bubble.deleted) {
        put(id, null);
        return null;
      }
      const moved =
        rectKey(bubble.rect) !== sent ||
        busyRef.current === id ||
        draggedRef.current.get(id) === token;
      if (!moved) return run;
      draggedRef.current.delete(id);
      if (run.auto) {
        put(id, { ...run, phase: "waiting", proposal: null, error: null });
      } else {
        put(id, null);
        sayRef.current(
          "The box moved while it was being analyzed, so that answer was dropped. Analyze again asks about the box as it is now.",
          "warn",
        );
      }
      return null;
    },
    [put],
  );

  const finish = useCallback(
    (id: string, token: number, sent: string, result: AnalyzeResult) => {
      const run = current(id, token, sent);
      if (!run) return;
      if (result.ok) {
        put(id, { ...run, phase: "ready", proposal: result.proposal });
      } else {
        put(id, { ...run, phase: "failed", error: result.error });
        sayRef.current(`Analyze failed: ${result.error}`, "warn");
      }
    },
    [current, put],
  );

  const start = useCallback(
    async (id: string) => {
      const bubble = docRef.current.bubbles[id];
      const page = bubble ? pagesRef.current.get(bubble.page) : undefined;
      if (!bubble || bubble.deleted || !page) return;
      tokenRef.current += 1;
      const token = tokenRef.current;
      const sent = rectKey(bubble.rect);
      draggedRef.current.delete(id);
      put(id, {
        phase: "running",
        auto: runsRef.current[id]?.auto ?? false,
        token,
        sent,
        proposal: null,
        error: null,
      });
      let result: AnalyzeResult;
      try {
        const cut = await cutBox(page.imageUrl, bubble.rect);
        // The image load takes time: an undo, a move or a drag since then
        // means this crop no longer stands for the box, so nothing is sent.
        if (!current(id, token, sent)) return;
        result = await analyzeBubble({
          bookId,
          issueId,
          pageNumber: bubble.page,
          box: cut.box,
          text: bubble.text,
          cropBase64: cut.crop,
          cast: castRef.current.map((c) => ({
            id: c.id,
            name: c.name,
            aliases: c.aliases,
          })),
          // An empty hint is no hint; the action trims it.
          hint: hintsRef.current[id],
        });
      } catch (e) {
        result = { ok: false, error: (e as Error).message };
      }
      finish(id, token, sent, result);
    },
    [bookId, issueId, put, current, finish],
  );

  // One timer per waiting box, restarted whenever the box changes and held
  // while it is dragged. A box that keeps still for a second is asked about.
  const timers = useRef(new Map<string, { key: string; timer: number }>());
  useEffect(() => {
    const want = new Map<string, string>();
    for (const [id, run] of Object.entries(runs)) {
      const b = doc.bubbles[id];
      if (run.phase === "waiting" && b && !b.deleted && busyId !== id)
        want.set(id, rectKey(b.rect));
    }
    for (const [id, t] of timers.current) {
      if (want.get(id) === t.key) continue;
      window.clearTimeout(t.timer);
      timers.current.delete(id);
    }
    for (const [id, key] of want) {
      if (timers.current.has(id)) continue;
      const timer = window.setTimeout(() => {
        timers.current.delete(id);
        void start(id);
      }, SETTLE_MS);
      timers.current.set(id, { key, timer });
    }
  }, [runs, doc, busyId, start]);
  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of all.values()) window.clearTimeout(t.timer);
      all.clear();
    };
  }, []);

  /** A box was just drawn: analyze it once it keeps still. */
  const arm = useCallback(
    (id: string) =>
      put(id, {
        phase: "waiting",
        auto: true,
        token: 0,
        sent: null,
        proposal: null,
        error: null,
      }),
    [put],
  );

  /**
   * A bubble's box changed. A drawn box whose call is out goes back to
   * waiting: that answer is stale and is dropped. A waiting box's timer
   * restarts on its own. A proposal or an error already showing stays.
   * `rect` is the box as asked for; clamped to the page it may be the box
   * the request was cut from (a nudge out past the edge), which is no move.
   */
  const moved = useCallback(
    (id: string, rect: Rect) => {
      const run = runsRef.current[id];
      if (!run?.auto || run.phase !== "running") return;
      if (rectKey(clampRect(rect)) === run.sent) return;
      put(id, { ...run, phase: "waiting", proposal: null, error: null });
    },
    [put],
  );

  /** Analyze again, or Try again: one call now, with the bubble's hint. */
  const analyze = useCallback(
    (id: string) => {
      if (runsRef.current[id]?.phase === "running") return;
      void start(id);
    },
    [start],
  );

  const accept = useCallback(
    (id: string) => {
      const run = runsRef.current[id];
      if (run?.phase !== "ready" || !run.proposal) return;
      onAccept(id, run.proposal);
      put(id, null);
    },
    [onAccept, put],
  );

  const setHint = useCallback((id: string, text: string) => {
    setHints((prev) => ({ ...prev, [id]: text }));
  }, []);

  return { runs, hints, arm, moved, analyze, accept, setHint };
}
