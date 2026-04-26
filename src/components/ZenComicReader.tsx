"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Image from "next/image";
import type { Bubble, AudioTimestamps } from "~/types";
import { useSettings } from "~/hooks/useSettings";
import { useAudioPlayback } from "~/hooks/useAudioPlayback";
import { useAutoPlay } from "~/hooks/useAutoPlay";
import { usePinchZoom } from "~/hooks/usePinchZoom";
import { usePageNavigation } from "~/hooks/usePageNavigation";
import { ControlBar } from "./zen-comic-reader/ControlBar";
import { SpeechBox } from "./zen-comic-reader/SpeechBox";
import { PageSheet } from "./zen-comic-reader/PageSheet";
import { SettingsSheet } from "./zen-comic-reader/SettingsSheet";
import { buildSpeechContent } from "./zen-comic-reader/text-utils";

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
}: ZenComicReaderProps) {
  const [selectedBubbleId, setSelectedBubbleId] = useState<string | null>(null);
  const [isPageSheetOpen, setIsPageSheetOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

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

  const { autoPlayEnabled, toggleAutoPlay } = useSettings();
  const { navigatePrev, navigateNext } = usePageNavigation({
    prevPageLink,
    nextPageLink,
  });
  const { scale, offset, resetView, handlers } = usePinchZoom({
    onSwipeLeft: navigateNext,
    onSwipeRight: navigatePrev,
  });

  // scheduleNextRef breaks the circular dep between useAudioPlayback and useAutoPlay
  const scheduleNextRef = useRef<((b: Bubble) => void) | null>(null);

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
    onBubbleEnded: useCallback((b: Bubble) => scheduleNextRef.current?.(b), []),
  });

  const playBubble = useCallback(
    (b: Bubble) => {
      setSelectedBubbleId(b.id);
      rawPlayBubble(b);
    },
    [rawPlayBubble],
  );

  const { scheduleNext, cancelPending } = useAutoPlay(
    visibleBubbles,
    autoPlayEnabled,
    playBubble,
  );

  scheduleNextRef.current = scheduleNext;

  const selectedBubble =
    visibleBubbles.find((b) => b.id === selectedBubbleId) ?? null;

  const handleBubbleClick = useCallback(
    (bubble: Bubble) => {
      if (selectedBubbleId === bubble.id) {
        togglePlayPause();
      } else {
        cancelPending();
        playBubble(bubble);
      }
    },
    [selectedBubbleId, togglePlayPause, cancelPending, playBubble],
  );

  const speech = selectedBubble
    ? buildSpeechContent(timestamps[selectedBubble.id], selectedBubble.ocr_text)
    : null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-black">
      <div className="relative flex flex-1 items-center justify-center overflow-hidden p-4">
        <div
          className="relative flex h-full w-full touch-none items-center justify-center"
          {...handlers}
        >
          <div
            className="relative mx-auto aspect-[2/3] max-h-[calc(100vh-140px)] w-full max-w-[min(100%,calc((100vh-140px)*0.667))] select-none"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transition: "transform 120ms ease-out",
            }}
          >
            <Image
              src={pageImage}
              alt="Comic page"
              fill
              className="object-contain"
              priority
            />
            {visibleBubbles.map((bubble) => {
              if (!bubble.style) return null;
              const isSelected = selectedBubbleId === bubble.id;
              return (
                <button
                  key={bubble.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBubbleClick(bubble);
                  }}
                  className={`absolute transition-all duration-300 ${
                    isSelected
                      ? "z-10 border-4 border-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.5)]"
                      : "border border-transparent hover:border-white/30 hover:bg-white/5"
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
          </div>
        </div>
      </div>

      <ControlBar
        onOpenPages={() => setIsPageSheetOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
      >
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

      {scale > 1 && (
        <button
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
