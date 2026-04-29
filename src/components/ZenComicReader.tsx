"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import type { Bubble, AudioTimestamps } from "~/types";
import type { PageDirectedPanel } from "~/types/panels";
import { useSettings } from "~/hooks/useSettings";
import { useAudioPlayback } from "~/hooks/useAudioPlayback";
import { useAutoPlay } from "~/hooks/useAutoPlay";
import { usePinchZoom } from "~/hooks/usePinchZoom";
import { usePageNavigation } from "~/hooks/usePageNavigation";
import { usePanelNavigation } from "~/hooks/usePanelNavigation";
import { useDoubleTap } from "~/hooks/useDoubleTap";
import { ControlBar } from "./zen-comic-reader/ControlBar";
import { SpeechBox } from "./zen-comic-reader/SpeechBox";
import { PageSheet } from "./zen-comic-reader/PageSheet";
import { SettingsSheet } from "./zen-comic-reader/SettingsSheet";
import { buildSpeechContent } from "./zen-comic-reader/text-utils";
import {
  PanelDimOverlay,
  PanelViewFrame,
  PanelViewHud,
  usePrefersReducedMotion,
} from "./zen-comic-reader/PanelView";

interface ZenComicReaderProps {
  pageImage: string;
  bubbles: Bubble[];
  timestamps: Record<string, AudioTimestamps>;
  bookId: string;
  issueId: string;
  prevPageLink?: string | null;
  nextPageLink?: string | null;
  pageNumber: number;
  pageCount: number;
  /** Directed panels for this page only (Supabase). Empty → panel view hidden. */
  panels?: PageDirectedPanel[];
}

export default function ZenComicReader({
  pageImage,
  bubbles,
  timestamps,
  bookId,
  issueId,
  prevPageLink,
  nextPageLink,
  pageNumber,
  pageCount,
  panels = [],
}: ZenComicReaderProps) {
  const [selectedBubbleId, setSelectedBubbleId] = useState<string | null>(null);
  const [isPageSheetOpen, setIsPageSheetOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [panelViewMode, setPanelViewMode] = useState(false);
  const [panelAutoPlay, setPanelAutoPlay] = useState(false);

  const reducedMotion = usePrefersReducedMotion();
  const focusBeforePanelRef = useRef<Element | null>(null);
  const panelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPanelTimer = useCallback(() => {
    if (panelTimerRef.current !== null) {
      clearTimeout(panelTimerRef.current);
      panelTimerRef.current = null;
    }
  }, []);

  const visibleBubbles = useMemo(
    () =>
      bubbles
        .filter(
          (b) =>
            !b.ignored &&
            (b.type === "SPEECH" ||
              b.type === "NARRATION" ||
              b.type === "CAPTION") &&
            b.style,
        )
        .sort((a, b) => (a.box_2d.index ?? 0) - (b.box_2d.index ?? 0)),
    [bubbles],
  );

  const exitPanelView = useCallback(() => {
    clearPanelTimer();
    setPanelViewMode(false);
    setPanelAutoPlay(false);
    const el = focusBeforePanelRef.current;
    focusBeforePanelRef.current = null;
    if (el instanceof HTMLElement) {
      queueMicrotask(() => el.focus());
    }
  }, [clearPanelTimer]);

  const togglePanelAutoPlay = useCallback(() => {
    setPanelAutoPlay((p) => !p);
  }, []);

  const {
    panelIndex,
    setPanelIndex,
    goNext: goNextPanel,
    goPrev: goPrevPanel,
    gestureBind,
    panelContainerRef,
  } = usePanelNavigation({
    panelCount: panels.length,
    enabled: panelViewMode && panels.length > 0,
    onExit: exitPanelView,
    onTogglePanelAutoPlay: togglePanelAutoPlay,
  });

  const activePanel = panels[panelIndex] ?? null;

  useEffect(() => {
    if (!panelViewMode || !activePanel) return;
    setSelectedBubbleId((id) =>
      id && activePanel.bubbleIds.includes(id) ? id : null,
    );
  }, [panelViewMode, panelIndex, activePanel]);

  const orderedPanelBubbles = useMemo(() => {
    if (!activePanel) return [];
    const idSet = new Set(activePanel.bubbleIds);
    return visibleBubbles
      .filter((b) => idSet.has(b.id))
      .sort((a, b) => (a.box_2d.index ?? 0) - (b.box_2d.index ?? 0));
  }, [activePanel, visibleBubbles]);

  const displayBubbles = useMemo(() => {
    if (!panelViewMode || !panels.length || !activePanel) return visibleBubbles;
    const idSet = new Set(activePanel.bubbleIds);
    return visibleBubbles.filter((b) => idSet.has(b.id));
  }, [panelViewMode, panels.length, activePanel, visibleBubbles]);

  const enterPanelView = useCallback(() => {
    if (!panels.length) return;
    focusBeforePanelRef.current = document.activeElement;
    setPanelIndex(0);
    setPanelViewMode(true);
  }, [panels.length, setPanelIndex]);

  const handleDoubleTap = useCallback(() => {
    if (panelViewMode) exitPanelView();
    else enterPanelView();
  }, [panelViewMode, exitPanelView, enterPanelView]);

  const doubleTapBinder = useDoubleTap(handleDoubleTap);
  const doubleTapProps = doubleTapBinder();

  const { autoPlayEnabled, toggleAutoPlay } = useSettings();
  const { navigatePrev, navigateNext } = usePageNavigation({
    prevPageLink,
    nextPageLink,
  });
  const {
    scale,
    offset,
    resetView,
    handlers: pinchHandlers,
  } = usePinchZoom({
    onSwipeLeft: navigateNext,
    onSwipeRight: navigatePrev,
    disabled: panelViewMode,
  });

  const scheduleNextRef = useRef<((b: Bubble) => void) | null>(null);
  const panelViewModeRef = useRef(panelViewMode);
  const panelAutoPlayRef = useRef(panelAutoPlay);
  const panelIndexRef = useRef(panelIndex);
  const orderedPanelBubblesRef = useRef(orderedPanelBubbles);
  const panelsRef = useRef(panels);
  const playBubbleRef = useRef<(b: Bubble) => void | undefined>(undefined);
  const goNextPanelRef = useRef(goNextPanel);

  useEffect(() => {
    panelViewModeRef.current = panelViewMode;
  }, [panelViewMode]);
  useEffect(() => {
    panelAutoPlayRef.current = panelAutoPlay;
  }, [panelAutoPlay]);
  useEffect(() => {
    panelIndexRef.current = panelIndex;
  }, [panelIndex]);
  useEffect(() => {
    orderedPanelBubblesRef.current = orderedPanelBubbles;
  }, [orderedPanelBubbles]);
  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);
  useEffect(() => {
    goNextPanelRef.current = goNextPanel;
  }, [goNextPanel]);

  const handleBubbleEnded = useCallback(
    (b: Bubble) => {
      if (panelViewModeRef.current) {
        if (!panelAutoPlayRef.current) return;
        clearPanelTimer();
        const list = orderedPanelBubblesRef.current;
        const idx = list.findIndex((x) => x.id === b.id);
        if (idx >= 0 && idx < list.length - 1) {
          const nextBubble = list[idx + 1];
          if (nextBubble) {
            panelTimerRef.current = setTimeout(() => {
              const play = playBubbleRef.current;
              if (nextBubble && play) play(nextBubble);
            }, 400);
          }
          return;
        }
        const pi = panelIndexRef.current;
        const plist = panelsRef.current;
        const panel = plist[pi];
        const dwellMs =
          panel?.estimatedDurationSeconds != null
            ? Math.max(
                400,
                Math.min(8000, panel.estimatedDurationSeconds * 1000),
              )
            : 1200;
        panelTimerRef.current = setTimeout(() => {
          if (pi < plist.length - 1) goNextPanelRef.current();
        }, dwellMs);
        return;
      }
      scheduleNextRef.current?.(b);
    },
    [clearPanelTimer],
  );

  const {
    playBubble: rawPlayBubble,
    stopAll,
    togglePlayPause,
    isPlaying,
    activeWordIndex,
  } = useAudioPlayback({
    bookId,
    issueId,
    timestamps,
    onBubbleEnded: handleBubbleEnded,
  });

  const playBubble = useCallback(
    (b: Bubble) => {
      setSelectedBubbleId(b.id);
      rawPlayBubble(b);
    },
    [rawPlayBubble],
  );

  useEffect(() => {
    playBubbleRef.current = playBubble;
  }, [playBubble]);

  const { scheduleNext, cancelPending } = useAutoPlay(
    visibleBubbles,
    autoPlayEnabled,
    playBubble,
  );

  scheduleNextRef.current = scheduleNext;

  useEffect(() => {
    if (!panelViewMode || !panelAutoPlay) return;
    clearPanelTimer();
    const panel = panels[panelIndex];
    if (!panel) return;
    const idSet = new Set(panel.bubbleIds);
    const list = visibleBubbles
      .filter((b) => idSet.has(b.id))
      .sort((a, b) => (a.box_2d.index ?? 0) - (b.box_2d.index ?? 0));
    if (!list.length) {
      const ms =
        panel.estimatedDurationSeconds != null
          ? Math.max(600, panel.estimatedDurationSeconds * 1000)
          : 2000;
      panelTimerRef.current = setTimeout(() => {
        if (panelIndexRef.current < panelsRef.current.length - 1) {
          goNextPanelRef.current();
        }
      }, ms);
      return () => clearPanelTimer();
    }
    const first = list[0];
    const play = playBubbleRef.current;
    if (first && play) play(first);
    return () => clearPanelTimer();
  }, [
    panelViewMode,
    panelAutoPlay,
    panelIndex,
    panels,
    visibleBubbles,
    clearPanelTimer,
  ]);

  const selectedBubble =
    displayBubbles.find((b) => b.id === selectedBubbleId) ?? null;

  const handleBubbleClick = useCallback(
    (bubble: Bubble) => {
      cancelPending();
      clearPanelTimer();
      if (selectedBubbleId === bubble.id) {
        togglePlayPause();
      } else {
        playBubble(bubble);
      }
    },
    [
      selectedBubbleId,
      togglePlayPause,
      cancelPending,
      playBubble,
      clearPanelTimer,
    ],
  );

  const speech = selectedBubble
    ? buildSpeechContent(timestamps[selectedBubble.id], selectedBubble.ocr_text)
    : null;

  const announceText = useMemo(() => {
    if (!panelViewMode || !panels.length || !activePanel) return "";
    const idx = panelIndex + 1;
    const total = panels.length;
    const speaker = activePanel.primarySpeaker ?? "Speaker";
    const firstBubble = orderedPanelBubbles[0];
    const snippet = firstBubble?.ocr_text?.slice(0, 120) ?? "";
    return `Panel ${idx} of ${total}. ${speaker} speaks: ${snippet}`;
  }, [
    panelViewMode,
    panels.length,
    panelIndex,
    activePanel,
    orderedPanelBubbles,
  ]);

  useEffect(() => {
    if (!panelViewMode || !panelContainerRef.current) return;
    panelContainerRef.current.focus();
  }, [panelViewMode, panelContainerRef, panelIndex]);

  const gestureProps = gestureBind();

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-black">
      <div className="relative flex flex-1 items-center justify-center overflow-hidden p-4">
        <div
          ref={panelContainerRef}
          tabIndex={panelViewMode ? 0 : -1}
          className="relative flex h-full w-full touch-none items-center justify-center outline-none"
          {...(panelViewMode ? gestureProps : pinchHandlers)}
        >
          <div
            {...doubleTapProps}
            className="relative flex max-h-full max-w-full flex-col items-center justify-center"
            style={{
              transform: panelViewMode
                ? undefined
                : `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transition: panelViewMode
                ? undefined
                : "transform 120ms ease-out",
            }}
          >
            <PanelViewFrame
              panelViewMode={panelViewMode}
              panels={panels}
              panelIndex={panelIndex}
              reducedMotion={reducedMotion}
            >
              <Image
                src={pageImage}
                alt="Comic page"
                fill
                className="object-contain"
                priority
              />
              {panelViewMode && activePanel ? (
                <PanelDimOverlay bbox={activePanel.boundingBox} />
              ) : null}
              {displayBubbles.map((bubble) => {
                if (!bubble.style) return null;
                const isSelected = selectedBubbleId === bubble.id;
                return (
                  <button
                    key={bubble.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleBubbleClick(bubble);
                    }}
                    className={`absolute transition-all duration-300 ${
                      isSelected
                        ? "z-10 border-4 border-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.5)]"
                        : "z-[5] border border-transparent hover:border-white/30 hover:bg-white/5"
                    }`}
                    style={{
                      left: bubble.style.left,
                      top: bubble.style.top,
                      width: bubble.style.width,
                      height: bubble.style.height,
                    }}
                    aria-label={`Bubble ${bubble.id}`}
                  />
                );
              })}
            </PanelViewFrame>
          </div>
        </div>
      </div>

      <ControlBar
        onOpenPages={() => setIsPageSheetOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
      >
        <div className="flex min-h-0 w-full flex-1 flex-col justify-center gap-2 overflow-hidden">
          {!panelViewMode && panels.length > 0 ? (
            <div className="flex shrink-0 justify-end">
              <button
                type="button"
                onClick={enterPanelView}
                className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium text-neutral-200 hover:bg-white/15"
              >
                Panel View
              </button>
            </div>
          ) : null}

          {panelViewMode && panels.length > 0 ? (
            <PanelViewHud
              panelIndex={panelIndex}
              panelCount={panels.length}
              onClose={exitPanelView}
              onPrev={goPrevPanel}
              onNext={goNextPanel}
              panelAutoPlay={panelAutoPlay}
              onTogglePanelAutoPlay={togglePanelAutoPlay}
              announceText={announceText}
            />
          ) : null}

          {speech ? (
            <SpeechBox
              speaker={selectedBubble?.speaker}
              text={speech.cleanText}
              words={speech.words}
              activeWordIndex={activeWordIndex}
              isPlaying={isPlaying}
              onTogglePlay={togglePlayPause}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500 italic">
              Tap a bubble to play
            </div>
          )}
        </div>
      </ControlBar>

      <PageSheet
        bookId={bookId}
        issueId={issueId}
        currentPage={pageNumber}
        pageCount={pageCount}
        isOpen={isPageSheetOpen}
        onClose={() => setIsPageSheetOpen(false)}
      />

      <SettingsSheet
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        autoPlayEnabled={autoPlayEnabled}
        onToggleAutoPlay={toggleAutoPlay}
        hasNext={!!nextPageLink}
        hasPrev={!!prevPageLink}
        onNext={navigateNext}
        onPrev={navigatePrev}
      />

      {!panelViewMode && scale > 1 && (
        <button
          type="button"
          onClick={() => {
            resetView();
            stopAll();
          }}
          className="absolute top-4 right-4 z-50 rounded-full bg-neutral-900/80 px-3 py-1 text-xs font-semibold text-neutral-200 shadow-lg backdrop-blur hover:bg-neutral-800"
        >
          Reset View
        </button>
      )}
    </div>
  );
}
