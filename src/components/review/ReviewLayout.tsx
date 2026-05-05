"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import type { Bubble } from "~/types";
import type { IssueManifest } from "~/types/manifest";
import { pageImageUrl } from "~/lib/storage";
import {
  useReviewEdits,
  mergeEdits,
  buildFixesJson,
  type LocalBubble,
  type EditChanges,
  type BubbleBounds,
} from "~/hooks/useReviewEdits";
import { BubbleOverlay } from "./BubbleOverlay";
import { BubbleSidebar } from "./BubbleSidebar";
import { DrawMode } from "./DrawMode";

interface ReviewLayoutProps {
  bookId: string;
  issueId: string;
  issueData: IssueManifest;
  allBubbles: Record<string, Bubble[]>;
  characters: string[];
  initialPage: number;
  mode?: string;
}

let newBubbleCounter = 0;
function nextTempId() {
  newBubbleCounter += 1;
  return `new-${String(newBubbleCounter).padStart(3, "0")}`;
}

function pageKey(pageNum: number) {
  return `page-${String(pageNum).padStart(2, "0")}.jpg`;
}

export function ReviewLayout({
  bookId,
  issueId,
  issueData,
  allBubbles,
  characters,
  initialPage,
  mode,
}: ReviewLayoutProps) {
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [deleteToast, setDeleteToast] = useState<string | null>(null);
  const deleteToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const speakerInputRef = useRef<HTMLInputElement | null>(null);

  const {
    edits,
    pageOrder,
    applyEdit,
    undoLast,
    canUndo,
    clearAll,
    redoSet,
    toggleRedo,
    setPageOrder,
    getPageOrder,
    loaded,
    pendingCount,
  } = useReviewEdits(bookId, issueId);

  const originalBubbles = useMemo(
    () => allBubbles[pageKey(currentPage)] ?? [],
    [allBubbles, currentPage],
  );

  const localBubbles: LocalBubble[] = useMemo(() => {
    const merged = mergeEdits(
      originalBubbles,
      edits.filter((e) => {
        if (e.action === "add") return e.pageIndex === currentPage;
        return true;
      }),
    );
    const order = getPageOrder(currentPage);
    if (!order) return merged;
    const idToIndex = new Map(order.map((id, i) => [id, i]));
    return [...merged].sort((a, b) => {
      const ai = idToIndex.get(a.id) ?? Infinity;
      const bi = idToIndex.get(b.id) ?? Infinity;
      return ai - bi;
    });
  }, [originalBubbles, edits, currentPage, getPageOrder]);

  const selectedBubble = localBubbles.find((b) => b.id === selectedId) ?? null;

  const navigatePage = useCallback(
    (delta: number) => {
      setCurrentPage((p) => {
        const next = Math.max(1, Math.min(p + delta, issueData.pageCount));
        if (next !== p) setSelectedId(null);
        return next;
      });
    },
    [issueData.pageCount],
  );

  const handleAdvance = useCallback(() => {
    const activeBubbles = localBubbles.filter((b) => b._status !== "deleted");
    if (activeBubbles.length === 0) return;
    const currentIndex = activeBubbles.findIndex((b) => b.id === selectedId);
    const nextIndex =
      currentIndex >= activeBubbles.length - 1 ? 0 : currentIndex + 1;
    setSelectedId(activeBubbles[nextIndex]!.id);
  }, [localBubbles, selectedId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inFormField =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement;

      if (e.key === "Escape") {
        if (drawMode) setDrawMode(false);
        else setSelectedId(null);
        return;
      }

      if (inFormField) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId) handleDelete(selectedId);
      }
      if (e.key === "ArrowLeft") navigatePage(-1);
      if (e.key === "ArrowRight") navigatePage(1);
      if (e.key === "a") {
        setDrawMode((v) => !v);
      }
      if (e.key === "Enter" && selectedId) {
        speakerInputRef.current?.focus();
        speakerInputRef.current?.select();
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const activeBubbles = localBubbles.filter(
          (b) => b._status !== "deleted",
        );
        if (activeBubbles.length === 0) return;
        const currentIndex = activeBubbles.findIndex(
          (b) => b.id === selectedId,
        );
        const nextIndex = e.shiftKey
          ? currentIndex <= 0
            ? activeBubbles.length - 1
            : currentIndex - 1
          : currentIndex >= activeBubbles.length - 1
            ? 0
            : currentIndex + 1;
        setSelectedId(activeBubbles[nextIndex]!.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawMode, selectedId, currentPage, issueData.pageCount, localBubbles]);

  const handleBubbleChange = useCallback(
    (id: string, changes: EditChanges) => {
      applyEdit({
        bubbleId: id,
        action: "update",
        changes,
        timestamp: Date.now(),
      });
    },
    [applyEdit],
  );

  const handleBoundsChange = useCallback(
    (id: string, bounds: BubbleBounds) => {
      applyEdit({
        bubbleId: id,
        action: "update",
        changes: { bounds },
        timestamp: Date.now(),
      });
    },
    [applyEdit],
  );

  const handleDelete = useCallback(
    (id: string) => {
      applyEdit({
        bubbleId: id,
        action: "delete",
        changes: {},
        timestamp: Date.now(),
      });
      setSelectedId(null);
      setDeleteToast(id);
      if (deleteToastTimerRef.current)
        clearTimeout(deleteToastTimerRef.current);
      deleteToastTimerRef.current = setTimeout(
        () => setDeleteToast(null),
        5000,
      );
    },
    [applyEdit],
  );

  const handleDraw = useCallback(
    (bounds: BubbleBounds) => {
      const tempId = nextTempId();
      applyEdit({
        bubbleId: tempId,
        action: "add",
        changes: {
          bounds,
          type: "SPEECH",
          speaker: null,
          emotion: "",
          ocr_text: "",
        },
        pageIndex: currentPage,
        timestamp: Date.now(),
      });
      setDrawMode(false);
      setSelectedId(tempId);
    },
    [applyEdit, currentPage],
  );

  const handleSetPageOrder = useCallback(
    (ids: string[]) => {
      const originalIds = originalBubbles.map((b) => b.id);
      const isOriginal =
        ids.length === originalIds.length &&
        ids.every((id, i) => id === originalIds[i]);
      setPageOrder(currentPage, isOriginal ? null : ids);
    },
    [originalBubbles, currentPage, setPageOrder],
  );

  const totalPendingCount = pendingCount + Object.keys(pageOrder).length;
  const [applyState, setApplyState] = useState<
    "idle" | "applying" | "success" | "error"
  >("idle");
  const [applyMessage, setApplyMessage] = useState<string | null>(null);

  const handleApplyToDb = useCallback(async () => {
    const secret = process.env.NEXT_PUBLIC_APPLY_FIXES_SECRET;
    if (!secret) {
      setApplyState("error");
      setApplyMessage("NEXT_PUBLIC_APPLY_FIXES_SECRET not set in client env.");
      return;
    }
    const json = buildFixesJson(bookId, issueId, edits, pageOrder, allBubbles);
    if (!json.fixes.length) return;
    setApplyState("applying");
    setApplyMessage(null);
    try {
      const res = await fetch("/api/apply-fixes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-apply-fixes-secret": secret,
        },
        body: JSON.stringify(json),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status}: ${text}`);
      }
      const result = (await res.json()) as {
        applied: number;
        skipped: string[];
        needsAudio: number;
      };
      setApplyState("success");
      const parts = [`Applied ${result.applied} fix(es)`];
      if (result.needsAudio > 0) parts.push(`${result.needsAudio} need audio`);
      if (result.skipped.length > 0)
        parts.push(`${result.skipped.length} skipped`);
      setApplyMessage(parts.join(" · "));
      clearAll();
      setTimeout(() => {
        setApplyState("idle");
        setApplyMessage(null);
      }, 5000);
    } catch (e) {
      setApplyState("error");
      setApplyMessage((e as Error).message);
    }
  }, [bookId, issueId, edits, pageOrder, allBubbles, clearAll]);

  const handleExport = useCallback(() => {
    const json = buildFixesJson(bookId, issueId, edits, pageOrder, allBubbles);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1);
    const filename = `fixes-${bookId}-${issueId}-${ts}.json`;
    const blob = new Blob([JSON.stringify(json, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    const keep = window.confirm(
      "Export complete. Clear saved edits?\n\nOK = Clear  |  Cancel = Keep",
    );
    if (keep === false) return;
    clearAll();
  }, [bookId, issueId, edits, pageOrder, allBubbles, clearAll]);

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-400">
        Loading edits…
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      {/* HEADER */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-neutral-800 bg-neutral-950 px-4">
        <Link
          href={`/book/${bookId}/${issueId}/${currentPage}`}
          className="flex items-center gap-1.5 text-sm text-neutral-400 hover:text-neutral-100"
        >
          ← Back to reader
        </Link>

        <span className="text-sm font-medium text-neutral-300">
          {issueData.name} — Review
        </span>

        <div className="flex items-center gap-2">
          {mode === "pipeline" && (
            <PipelineApproveButton bookId={bookId} issueId={issueId} />
          )}
          {applyMessage && (
            <span
              className={`text-xs ${
                applyState === "error" ? "text-red-400" : "text-emerald-400"
              }`}
            >
              {applyMessage}
            </span>
          )}
          <button
            onClick={handleApplyToDb}
            disabled={totalPendingCount === 0 || applyState === "applying"}
            className="flex items-center gap-1.5 rounded bg-emerald-700 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {applyState === "applying" ? "Applying…" : "Apply to DB"}
            {totalPendingCount > 0 && applyState !== "applying" && (
              <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px]">
                {totalPendingCount}
              </span>
            )}
          </button>
          <button
            onClick={handleExport}
            disabled={totalPendingCount === 0}
            className="flex items-center gap-1.5 rounded bg-cyan-700 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Export Fixes
            {totalPendingCount > 0 && (
              <span className="rounded-full bg-cyan-500 px-1.5 py-0.5 text-[10px]">
                {totalPendingCount}
              </span>
            )}
          </button>

          {/* Overflow menu */}
          <details className="relative">
            <summary className="cursor-pointer list-none rounded p-1 text-neutral-400 hover:bg-neutral-800">
              ⋯
            </summary>
            <div className="absolute top-full right-0 z-50 mt-1 w-40 rounded border border-neutral-700 bg-neutral-900 py-1 shadow-lg">
              <button
                onClick={() => {
                  if (window.confirm("Clear all saved edits?")) clearAll();
                }}
                className="w-full px-3 py-1.5 text-left text-xs text-red-400 hover:bg-neutral-800"
              >
                Clear all edits
              </button>
            </div>
          </details>
        </div>
      </header>

      {/* BODY */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left — comic page */}
        <div
          className="relative flex flex-1 items-center justify-center overflow-hidden bg-neutral-900 p-4"
          onClick={() => {
            if (!drawMode) setSelectedId(null);
          }}
        >
          <div
            ref={containerRef}
            className="relative mx-auto aspect-[2/3] max-h-full w-full max-w-[calc(100%)] select-none"
            style={{ maxWidth: "min(65vw, calc((100vh - 144px) * 0.667))" }}
          >
            <Image
              src={pageImageUrl(bookId, issueId, currentPage)}
              alt={`Page ${currentPage}`}
              fill
              className="object-contain"
              priority
            />

            <BubbleOverlay
              bubbles={localBubbles}
              selectedBubbleId={selectedId}
              redoSet={redoSet}
              containerRef={containerRef}
              onSelect={setSelectedId}
              onBoundsChange={handleBoundsChange}
            />

            <DrawMode
              active={drawMode}
              containerRef={containerRef}
              onDraw={handleDraw}
              onCancel={() => setDrawMode(false)}
            />
          </div>
        </div>

        {/* Right — sidebar */}
        <div className="w-80 shrink-0 xl:w-96">
          <BubbleSidebar
            bubble={selectedBubble}
            bubbles={localBubbles}
            characters={characters}
            redoSet={redoSet}
            selectedId={selectedId}
            speakerRef={speakerInputRef}
            bookId={bookId}
            issueId={issueId}
            pageNumber={currentPage}
            onSelect={setSelectedId}
            onAdvance={handleAdvance}
            onSetPageOrder={handleSetPageOrder}
            onChange={handleBubbleChange}
            onMarkRedo={toggleRedo}
            onDelete={handleDelete}
          />
        </div>
      </div>

      {/* FOOTER */}
      <footer className="flex h-12 shrink-0 items-center justify-between border-t border-neutral-800 bg-neutral-950 px-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigatePage(-1)}
            disabled={currentPage <= 1}
            className="rounded px-2 py-1 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-white disabled:opacity-30"
          >
            ◀ Prev
          </button>
          <span className="text-sm text-neutral-400">
            Page {currentPage} / {issueData.pageCount}
          </span>
          <button
            onClick={() => navigatePage(1)}
            disabled={currentPage >= issueData.pageCount}
            className="rounded px-2 py-1 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-white disabled:opacity-30"
          >
            Next ▶
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setDrawMode((v) => !v)}
            className={`rounded px-2 py-1 text-xs font-medium ${
              drawMode
                ? "bg-cyan-700 text-white"
                : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
            }`}
          >
            + Add Bubble
          </button>
          <button
            onClick={() => selectedId && handleDelete(selectedId)}
            disabled={!selectedId}
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-white disabled:opacity-30"
          >
            Delete Selected
          </button>
          <button
            onClick={undoLast}
            disabled={!canUndo}
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-white disabled:opacity-30"
          >
            Undo
          </button>
        </div>
      </footer>

      {/* Delete undo toast */}
      {deleteToast && (
        <div className="fixed bottom-16 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-neutral-800 px-4 py-2 text-sm text-white shadow-lg">
          Bubble deleted.{" "}
          <button
            onClick={() => {
              undoLast();
              setDeleteToast(null);
            }}
            className="ml-2 font-semibold text-cyan-400 underline"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

function PipelineApproveButton({
  bookId,
  issueId,
}: {
  bookId: string;
  issueId: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");

  async function handleApprove() {
    setState("loading");
    const res = await fetch("/api/admin/resume-hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId, issueId, step: "page-review" }),
    });
    setState(res.ok ? "done" : "idle");
  }

  if (state === "done") {
    return (
      <span className="rounded bg-emerald-700/30 px-3 py-1 text-xs font-medium text-emerald-300">
        Pipeline Resumed
      </span>
    );
  }

  return (
    <button
      onClick={handleApprove}
      disabled={state === "loading"}
      className="rounded bg-amber-700 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
    >
      {state === "loading" ? "Resuming..." : "Approve & Continue Pipeline"}
    </button>
  );
}
