// THROWAWAY spike prototype for comic-reader #325, variant D (the reel).
// Siloed under src/app/admin/proto/d/ — never merged.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelStrip, type PendingBox } from "./PanelStrip";
import { ClipLane, type LaneGroup } from "./ClipLane";
import { Inspector } from "./Inspector";
import { FullPageView } from "./FullPageView";
import {
  byTopLeft,
  containment,
  problemFor,
  GENERIC_ROLES,
  type ClipData,
  type EditorData,
  type Problem,
  type Rect,
} from "./data";

type Snapshot = { clips: ClipData[]; panels: EditorData["panels"] };

const UNDO_LIMIT = 25;

/** Plausible filler for the simulated analyze. Nothing here is a real result. */
const SIM_LINES = [
  "We should get out of here before they see us.",
  "Wait — did you hear that?",
  "Not now. Later, when nobody's looking.",
  "You always do this.",
  "Over here! Quick!",
];
const SIM_EMOTIONS = ["neutral", "urgent", "worried", "annoyed", "excited"];

export function ReelClient({
  data,
  initialPage,
  initialFullPage,
}: {
  data: EditorData;
  initialPage: number;
  initialFullPage: boolean;
}) {
  const [clips, setClips] = useState<ClipData[]>(data.clips);
  const [panels, setPanels] = useState(data.panels);
  const [pageNumber, setPageNumber] = useState(initialPage);
  const [playheadId, setPlayheadId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [cast, setCast] = useState<string[]>(data.characters);
  const [drawMode, setDrawMode] = useState(false);
  const [fullPage, setFullPage] = useState(initialFullPage);
  const [showKeys, setShowKeys] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [analyzed, setAnalyzed] = useState<Record<string, boolean>>({});

  const undoRef = useRef<Snapshot[]>([]);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A deferred callback. Not tracked for cleanup: this is a prototype and
  // every one of these fires within two seconds of the tab staying open.
  const later = useCallback((fn: () => void, ms: number) => {
    setTimeout(fn, ms);
  }, []);

  const flash = useCallback((message: string) => {
    setNote(message);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 5000);
  }, []);

  /**
   * Snapshot for undo, then apply. Every discrete edit goes through here.
   * The snapshot comes from refs rather than the render's `clips` and
   * `panels`, so two edits inside one React batch each undo one step
   * instead of the second overwriting the first's snapshot.
   */
  const latest = useRef({ clips, panels });
  latest.current = { clips, panels };

  const commit = useCallback((mutate: (draft: ClipData[]) => ClipData[]) => {
    undoRef.current.push(latest.current);
    if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift();
    setClips((prev) => {
      const next = mutate(prev);
      latest.current = { ...latest.current, clips: next };
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) {
      flash("Nothing left to undo.");
      return;
    }
    setClips(prev.clips);
    setPanels(prev.panels);
    latest.current = prev;
    flash("Undid the last edit.");
  }, [flash]);

  const page = useMemo(
    () => data.pages.find((p) => p.number === pageNumber) ?? data.pages[0],
    [data.pages, pageNumber],
  );

  const pagePanels = useMemo(
    () =>
      panels
        .filter((p) => p.pageNumber === pageNumber)
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [panels, pageNumber],
  );

  const pageClips = useMemo(
    () => clips.filter((c) => c.pageNumber === pageNumber),
    [clips, pageNumber],
  );

  /**
   * Playback order: panel by panel in reading order, and inside a panel by
   * the box's top-left corner, which is where a newly drawn bubble lands
   * without anyone dragging it into place.
   */
  const orderedClips = useMemo(() => {
    const groups = new Map<string, ClipData[]>();
    const orphans: ClipData[] = [];
    for (const panel of pagePanels) {
      groups.set(
        panel.id,
        pageClips
          .filter((c) => c.panelId === panel.id)
          .sort((a, b) => {
            if (a.box && b.box) return byTopLeft(a.box, b.box);
            return a.order - b.order;
          }),
      );
    }
    for (const clip of pageClips) {
      if (!clip.panelId || !groups.has(clip.panelId)) orphans.push(clip);
    }
    orphans.sort((a, b) => (a.box && b.box ? byTopLeft(a.box, b.box) : 0));
    if (orphans.length) groups.set("__none__", orphans);
    return Array.from(groups.entries());
  }, [pagePanels, pageClips]);

  const laneGroups: LaneGroup[] = useMemo(
    () =>
      orderedClips
        .filter(
          ([, groupClips]) => groupClips.length > 0 || groupClips !== null,
        )
        .map(([panelId, groupClips]) => ({
          panelId: panelId === "__none__" ? null : panelId,
          label:
            panelId === "__none__"
              ? "no panel"
              : `panel ${pagePanels.findIndex((p) => p.id === panelId) + 1}`,
          clips: groupClips,
        })),
    [orderedClips, pagePanels],
  );

  const flatLane = useMemo(
    () => laneGroups.flatMap((g) => g.clips),
    [laneGroups],
  );

  const problems = useMemo(() => {
    const out: Record<string, Problem | null> = {};
    for (const clip of pageClips) {
      out[clip.id] = problemFor(clip, cast, pageClips);
    }
    return out;
  }, [pageClips, cast]);

  const flaggedClips = useMemo(
    () => flatLane.filter((c) => problems[c.id]),
    [flatLane, problems],
  );

  const blockers = useMemo(
    () =>
      pageClips.filter(
        (c) => c.type === "speech" && !c.speaker && !c.silent && !c.ignored,
      ),
    [pageClips],
  );

  const currentClip = useMemo(
    () =>
      flatLane.find((c) => c.id === playheadId) ??
      flatLane.find((c) => c.id === selectedId) ??
      null,
    [flatLane, playheadId, selectedId],
  );

  const enlargedPanelId = useMemo(
    () => currentClip?.panelId ?? pagePanels[0]?.id ?? null,
    [currentClip, pagePanels],
  );

  /** The simulated analyze. About a second, then plausible values, no calls. */
  const runSimulatedAnalyze = useCallback(
    (id: string) => {
      setAnalyzing(id);
      later(() => {
        setAnalyzing(null);
        const seed = id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
        const line = SIM_LINES[seed % SIM_LINES.length] ?? SIM_LINES[0] ?? "";
        const emotion = SIM_EMOTIONS[(seed >> 3) % SIM_EMOTIONS.length] ?? "";
        const speaker = cast[seed % Math.max(cast.length, 1)] ?? null;
        commit((prev) =>
          prev.map((c) =>
            c.id === id
              ? {
                  ...c,
                  text: c.text || line,
                  emotion: c.emotion || emotion,
                  speaker: c.speaker ?? speaker,
                }
              : c,
          ),
        );
        setAnalyzed((prev) => ({ ...prev, [id]: true }));
        flash(
          "Simulated analyze filled this bubble — no model was called. Edit it, or retry.",
        );
      }, 1000);
    },
    [cast, commit, later, flash],
  );

  const handleDrawn = useCallback(
    (pending: PendingBox) => {
      // The brief's rule: the bubble lands in the panel it overlaps most, so
      // the drawn panel is only the starting guess.
      let panelId = pending.panelId;
      let best = -1;
      for (const panel of pagePanels) {
        const score = containment(pending.rect, panel.box);
        if (score > best) {
          best = score;
          panelId = panel.id;
        }
      }

      const id = `new-${Date.now().toString(36)}`;
      const clip: ClipData = {
        id,
        pageNumber,
        panelId,
        text: "",
        speaker: null,
        emotion: "",
        type: "speech",
        ignored: false,
        silent: false,
        box: pending.rect,
        order: 0,
        isNew: true,
      };

      // One commit: insert, then renumber the panel so the new bubble sits by
      // its box's top-left corner with nothing dragged into place.
      commit((prev) => {
        const next = [...prev, clip];
        const peers = next
          .filter((c) => c.panelId === panelId)
          .sort((a, b) => {
            if (a.id === id) return b.box ? -1 : 1;
            if (b.id === id) return a.box ? 1 : -1;
            if (a.box && b.box) return byTopLeft(a.box, b.box);
            return a.order - b.order;
          });
        const orderOf = new Map(peers.map((c, i) => [c.id, i]));
        return next.map((c) =>
          orderOf.has(c.id) ? { ...c, order: orderOf.get(c.id)! } : c,
        );
      });

      setDrawMode(false);
      setPlayheadId(id);
      setSelectedId(id);
      setSelectedPanelId(panelId);
      runSimulatedAnalyze(id);
    },
    [pagePanels, pageNumber, commit, runSimulatedAnalyze],
  );

  const stepPlayhead = useCallback(
    (delta: number) => {
      if (flatLane.length === 0) return;
      const index = flatLane.findIndex((c) => c.id === playheadId);
      const nextIndex =
        index < 0
          ? 0
          : Math.max(0, Math.min(flatLane.length - 1, index + delta));
      const next = flatLane[nextIndex];
      if (!next) return;
      setPlayheadId(next.id);
      setSelectedId(next.id);
      setSelectedPanelId(next.panelId);
    },
    [flatLane, playheadId],
  );

  const jumpToProblem = useCallback(() => {
    if (flaggedClips.length === 0) return;
    const index = flatLane.findIndex((c) => c.id === playheadId);
    const target =
      flaggedClips.find(
        (c) => flatLane.findIndex((f) => f.id === c.id) > index,
      ) ?? flaggedClips[0];
    if (!target) return;
    setPlayheadId(target.id);
    setSelectedId(target.id);
    setSelectedPanelId(target.panelId);
  }, [flaggedClips, flatLane, playheadId]);

  /**
   * Page navigation keeps the context: the new page's lane opens on the clip
   * nearest where the playhead was, so a walk down the issue does not lose
   * its place, and coming back lands on the same clip.
   */
  const lastPositionRef = useRef(0);
  const changePage = useCallback(
    (delta: number) => {
      const index = data.pages.findIndex((p) => p.number === pageNumber);
      const next = data.pages[index + delta];
      if (!next) return;
      lastPositionRef.current = Math.max(
        0,
        flatLane.findIndex((c) => c.id === playheadId),
      );
      setPageNumber(next.number);
      setFullPage(false);
      setSelectedPanelId(null);
      setDrawMode(false);
    },
    [data.pages, pageNumber, flatLane, playheadId],
  );

  /**
   * Page navigation keeps its place: the lane opens on the clip at the same
   * index it was on, so walking down an issue and coming back lands where
   * Doug was. Keyed on the page number alone — depending on the lane would
   * re-run this after every edit and yank the playhead out from under him.
   */
  const restoredForRef = useRef<number | null>(null);
  useEffect(() => {
    if (restoredForRef.current === pageNumber) return;
    restoredForRef.current = pageNumber;
    const ordered = orderedClips.flatMap(([, g]) => g);
    const target =
      ordered[
        Math.min(lastPositionRef.current, Math.max(0, ordered.length - 1))
      ];
    if (target) {
      setPlayheadId(target.id);
      setSelectedId(target.id);
      setSelectedPanelId(target.panelId);
    }
  }, [pageNumber, orderedClips, pageClips.length]);

  const updateClip = useCallback(
    (id: string, patch: Partial<ClipData>) => {
      commit((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    },
    [commit],
  );

  /** Reorder inside a panel, or across panels when the drop target differs. */
  const reorder = useCallback(
    (clipId: string, targetId: string) => {
      commit((prev) => {
        const clip = prev.find((c) => c.id === clipId);
        const target = prev.find((c) => c.id === targetId);
        if (!clip || !target) return prev;
        const panelId = target.panelId;
        const peers = prev
          .filter((c) => c.panelId === panelId && c.id !== clipId)
          .concat([{ ...clip, panelId }])
          .sort((a, b) => {
            if (a.box && b.box) return byTopLeft(a.box, b.box);
            return a.order - b.order;
          });
        const orderOf = new Map(peers.map((c, i) => [c.id, i]));
        return prev.map((c) => {
          const order = orderOf.get(c.id);
          if (order === undefined) return c;
          return c.id === clipId ? { ...c, panelId, order } : { ...c, order };
        });
      });
    },
    [commit],
  );

  const moveToPanel = useCallback(
    (clipId: string, panelId: string) => {
      commit((prev) => {
        const clip = prev.find((c) => c.id === clipId);
        if (!clip) return prev;
        const peers = prev
          .filter((c) => c.panelId === panelId && c.id !== clipId)
          .concat([{ ...clip, panelId }])
          .sort((a, b) => {
            if (a.box && b.box) return byTopLeft(a.box, b.box);
            return a.order - b.order;
          });
        const orderOf = new Map(peers.map((c, i) => [c.id, i]));
        return prev.map((c) => {
          const order = orderOf.get(c.id);
          if (order === undefined) return c;
          return c.id === clipId ? { ...c, panelId, order } : { ...c, order };
        });
      });
      flash("Moved to that panel and re-sorted by the box's corner.");
    },
    [commit, flash],
  );

  const deleteClip = useCallback(
    (id: string) => {
      commit((prev) => prev.filter((c) => c.id !== id));
      if (playheadId === id) setPlayheadId(null);
      if (selectedId === id) setSelectedId(null);
    },
    [commit, playheadId, selectedId],
  );

  // Box moves stream while a pointer is down; they don't each cost an undo step.
  const moveClipBox = useCallback((id: string, rect: Rect) => {
    setClips((prev) =>
      prev.map((c) => (c.id === id ? { ...c, box: rect } : c)),
    );
  }, []);

  const movePanelBox = useCallback((id: string, rect: Rect) => {
    setPanels((prev) =>
      prev.map((p) => (p.id === id ? { ...p, box: rect } : p)),
    );
  }, []);

  const focusClip = useCallback(
    (id: string) => {
      setSelectedId(id);
      setPlayheadId(id);
      const clip = clips.find((c) => c.id === id);
      if (clip) setSelectedPanelId(clip.panelId);
    },
    [clips],
  );

  const approve = useCallback(
    (scope: "page" | "issue") => {
      const issueBlockers = clips.filter(
        (c) => c.type === "speech" && !c.speaker && !c.silent && !c.ignored,
      );
      const relevant = scope === "page" ? blockers : issueBlockers;
      if (relevant.length > 0) {
        const first = relevant[0];
        flash(
          `Blocked: ${relevant.length} spoken ${relevant.length === 1 ? "bubble has" : "bubbles have"} no speaker. Jumping to the first.`,
        );
        if (!first) return;
        setPageNumber(first.pageNumber);
        setFullPage(false);
        focusClip(first.id);
        return;
      }
      setApproved((prev) => ({
        ...prev,
        [scope === "page" ? `page-${pageNumber}` : "issue"]: true,
      }));
      flash(
        `Approved the ${scope}. Nothing was written — this is a prototype.`,
      );
    },
    [blockers, clips, pageNumber, focusClip, flash],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
        return;
      }
      switch (event.key) {
        case "ArrowRight":
          event.preventDefault();
          stepPlayhead(1);
          break;
        case "ArrowLeft":
          event.preventDefault();
          stepPlayhead(-1);
          break;
        case "PageDown":
        case "]":
          event.preventDefault();
          changePage(1);
          break;
        case "PageUp":
        case "[":
          event.preventDefault();
          changePage(-1);
          break;
        case "n":
          event.preventDefault();
          jumpToProblem();
          break;
        case "d":
          event.preventDefault();
          setDrawMode((v) => !v);
          break;
        case "f":
          event.preventDefault();
          setFullPage((v) => !v);
          break;
        case "p":
          event.preventDefault();
          approve("page");
          break;
        case "?":
          event.preventDefault();
          setShowKeys((v) => !v);
          break;
        case "Escape":
          setFullPage(false);
          setShowKeys(false);
          setDrawMode(false);
          break;
        default:
          break;
      }
    },
    [approve, changePage, jumpToProblem, stepPlayhead, undo],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  if (!page) {
    return (
      <main className="min-h-screen bg-neutral-950 p-6 text-sm text-neutral-400">
        No pages for {data.bookId} / {data.issueId}.
      </main>
    );
  }

  const pageIndex = data.pages.findIndex((p) => p.number === pageNumber);
  const panelNumber = (id: string | null) =>
    id ? pagePanels.findIndex((p) => p.id === id) + 1 : 0;

  return (
    <main className="flex min-h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-neutral-800 px-3 py-2">
        <h1 className="text-[13px] font-medium">
          Reel{" "}
          <span className="text-neutral-500">
            {data.bookName} · {data.issueName}
          </span>
        </h1>
        <span className="text-[11px] text-neutral-600">
          throwaway prototype · #325
        </span>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => changePage(-1)}
            disabled={pageIndex <= 0}
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
          >
            ◀ page
          </button>
          <span className="text-[11px] text-neutral-400">
            {pageIndex + 1} / {data.pages.length}
          </span>
          <button
            type="button"
            onClick={() => changePage(1)}
            disabled={pageIndex >= data.pages.length - 1}
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
          >
            page ▶
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={undo}
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200"
          >
            Undo (⌘Z)
          </button>
          <button
            type="button"
            onClick={() => setFullPage(true)}
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200"
          >
            Full page (f)
          </button>
          <button
            type="button"
            onClick={() => setShowKeys((v) => !v)}
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200"
          >
            Keys (?)
          </button>
          <button
            type="button"
            onClick={() =>
              flash(
                "Saved. Nothing was written — every edit lives in this browser tab.",
              )
            }
            className="rounded border border-neutral-600 px-1.5 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-800"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => approve("page")}
            className={`rounded border px-1.5 py-0.5 text-[11px] ${
              blockers.length > 0
                ? "border-amber-800 text-amber-500"
                : "border-neutral-600 text-neutral-200 hover:bg-neutral-800"
            }`}
          >
            {approved[`page-${pageNumber}`]
              ? "Page approved"
              : "Approve page (p)"}
          </button>
          <button
            type="button"
            onClick={() => approve("issue")}
            className="rounded border border-neutral-600 px-1.5 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-800"
          >
            {approved.issue ? "Issue approved" : "Approve issue"}
          </button>
        </div>

        <span
          className={`ml-auto text-[11px] ${
            blockers.length > 0 ? "text-amber-400" : "text-neutral-500"
          }`}
        >
          {blockers.length > 0
            ? `${blockers.length} spoken ${blockers.length === 1 ? "bubble" : "bubbles"} with no speaker — approval blocked`
            : "nothing blocking approval"}
        </span>
      </header>

      {showKeys && <CheatSheet onClose={() => setShowKeys(false)} />}

      <div className="flex-1">
        {fullPage ? (
          <div className="h-[calc(100vh-100px)]">
            <FullPageView
              page={page}
              panels={pagePanels}
              clips={pageClips}
              selectedPanelId={selectedPanelId}
              selectedClipId={selectedId}
              problems={problems}
              onSelectPanel={(id) => {
                setSelectedPanelId(id);
                const first = flatLane.find((c) => c.panelId === id);
                if (first) focusClip(first.id);
              }}
              onSelectClip={focusClip}
              onMovePanelBox={movePanelBox}
              onMoveClipBox={moveClipBox}
            />
          </div>
        ) : (
          <>
            <PanelStrip
              page={page}
              panels={pagePanels}
              clips={pageClips}
              selectedPanelId={selectedPanelId}
              enlargedPanelId={enlargedPanelId}
              selectedClipId={selectedId}
              problems={problems}
              drawMode={drawMode}
              onSelectPanel={(id) => {
                setSelectedPanelId(id);
                const first = flatLane.find((c) => c.panelId === id);
                if (first) focusClip(first.id);
              }}
              onSelectClip={focusClip}
              onMoveClipBox={moveClipBox}
              onDrawnBox={handleDrawn}
              onToggleDrawMode={() => setDrawMode((v) => !v)}
            />

            <ClipLane
              groups={laneGroups}
              playheadId={playheadId}
              selectedId={selectedId}
              problems={problems}
              needsCount={flaggedClips.length}
              onSelect={focusClip}
              onStepPlayhead={stepPlayhead}
              onJumpToProblem={jumpToProblem}
              onReorder={reorder}
              onMoveToPanel={moveToPanel}
            />

            <Inspector
              clip={currentClip}
              panels={pagePanels}
              panelLabel={String(panelNumber(currentClip?.panelId ?? null))}
              cast={[
                ...cast,
                ...GENERIC_ROLES.filter((g) => !cast.includes(g)),
              ]}
              problem={currentClip ? (problems[currentClip.id] ?? null) : null}
              analyzing={
                analyzing !== null && analyzing === currentClip?.id
                  ? analyzing
                  : null
              }
              analyzed={currentClip ? Boolean(analyzed[currentClip.id]) : false}
              onChange={(patch) => {
                if (!currentClip) return;
                updateClip(currentClip.id, patch);
              }}
              onRetryAnalyze={() => {
                if (currentClip) runSimulatedAnalyze(currentClip.id);
              }}
              onDismissDuplicate={() => {
                if (!currentClip) return;
                updateClip(currentClip.id, { ignored: true });
                flash("Duplicate dismissed. Undo brings it back.");
              }}
              onAddCharacter={(name) => {
                if (!name) return;
                setCast((prev) =>
                  prev.includes(name) ? prev : [...prev, name],
                );
                flash(`Added ${name} to this issue's cast.`);
              }}
              onDelete={() => {
                if (currentClip) deleteClip(currentClip.id);
              }}
            />
          </>
        )}
      </div>

      <footer className="flex min-h-8 items-center gap-3 border-t border-neutral-800 px-3 py-1.5 text-[11px]">
        {analyzing ? (
          <span className="text-sky-400">
            Simulated analyze running — no model is being called…
          </span>
        ) : note ? (
          <span className="text-neutral-300">{note}</span>
        ) : (
          <span className="text-neutral-600">
            Every edit is local. Nothing is written.
          </span>
        )}
        {currentClip && (
          <span className="ml-auto text-neutral-600">
            {currentClip.text.length} chars · panel{" "}
            {panelNumber(currentClip.panelId)}
            {currentClip.isNew ? " · new" : ""}
            {analyzed[currentClip.id] ? " · simulated fields" : ""}
          </span>
        )}
      </footer>
    </main>
  );
}

function CheatSheet({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ["← →", "step the playhead one clip"],
    ["[ ] · PageUp/Down", "previous / next page"],
    ["n", "jump to the next problem"],
    ["d", "draw a bubble on the enlarged panel"],
    ["f", "open the full page"],
    ["p", "approve the page"],
    ["⌘Z", "undo the last edit"],
    ["?", "close this sheet"],
    ["Esc", "leave full page, drawing, this sheet"],
    ["drag a clip", "reorder it, or drop it under another panel"],
    ["drag / shift-drag", "move a box; shift-drag a panel edge resizes"],
  ];
  return (
    <div className="absolute top-11 left-3 z-50 w-96 rounded border border-neutral-700 bg-neutral-950 p-3 shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] tracking-wide text-neutral-400 uppercase">
          Keys
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-neutral-500 hover:text-neutral-200"
        >
          close
        </button>
      </div>
      <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-[11px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-mono text-neutral-300">{k}</dt>
            <dd className="text-neutral-500">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
