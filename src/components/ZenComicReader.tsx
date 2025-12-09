"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Bubble, CharacterAlignment, AudioTimestamps } from "~/types";
import SpeechBox from "./zen-reader/SpeechBox";
import PageSelectorSheet from "./zen-reader/PageSelectorSheet";
import SettingsSheet from "./zen-reader/SettingsSheet";
import { buildWordTimings, type WordTiming } from "./zen-reader/helpers";

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

const MIN_SWIPE_DISTANCE = 50;
const MIN_SCALE = 1;
const MAX_SCALE = 3.5;

function distanceBetween(
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function clampScale(value: number) {
  return Math.min(Math.max(value, MIN_SCALE), MAX_SCALE);
}

function clampOffset(value: number) {
  return Math.min(Math.max(value, -520), 520);
}

const AUTOPLAY_KEY = "zen-reader-autoplay";

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
  const [autoPlayEnabled, setAutoPlayEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(AUTOPLAY_KEY);
    return stored ? stored === "true" : true;
  });
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPageSheetOpen, setIsPageSheetOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const autoPlayTimerRef = useRef<NodeJS.Timeout | null>(null);
  const highlightRafRef = useRef<number | null>(null);
  const wordTimingsRef = useRef<WordTiming[]>([]);
  const pointerMapRef = useRef<Map<number, { x: number; y: number }>>(
    new Map(),
  );
  const initialPinchRef = useRef<{ distance: number; scale: number } | null>(
    null,
  );
  const swipeStartRef = useRef<number | null>(null);
  const router = useRouter();

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

  const selectedBubble =
    visibleBubbles.find((b) => b.id === selectedBubbleId) ?? null;

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      if (autoPlayTimerRef.current) {
        clearTimeout(autoPlayTimerRef.current);
      }
      if (highlightRafRef.current) {
        cancelAnimationFrame(highlightRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(AUTOPLAY_KEY, String(autoPlayEnabled));
  }, [autoPlayEnabled]);

  const startHighlightLoop = (
    audio: HTMLAudioElement,
    timings: WordTiming[],
  ) => {
    if (highlightRafRef.current) {
      cancelAnimationFrame(highlightRafRef.current);
    }

    const tick = () => {
      if (!audio) return;
      if (!audio.paused && !audio.ended) {
        const currentTime = audio.currentTime;
        const active = timings.find(
          (w) =>
            currentTime >= (w.start ?? 0) &&
            currentTime <= (w.end ?? w.start ?? 0),
        );
        setActiveWordIndex(active?.index ?? null);
      }
      highlightRafRef.current = requestAnimationFrame(tick);
    };

    highlightRafRef.current = requestAnimationFrame(tick);
  };

  const playBubble = (bubble: Bubble) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current);
      autoPlayTimerRef.current = null;
    }
    if (highlightRafRef.current) {
      cancelAnimationFrame(highlightRafRef.current);
    }

    setActiveWordIndex(null);

    const audioUrl = `/comics/${bookId}/${issueId}/audio/${bubble.id}.mp3`;
    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    const bubbleTimestamps = timestamps[bubble.id] as
      | {
          alignment?: CharacterAlignment | null;
          normalized_alignment?: CharacterAlignment | null;
        }
      | undefined;

    const alignment =
      bubbleTimestamps?.normalized_alignment ??
      bubbleTimestamps?.alignment ??
      null;
    const wordTimings = buildWordTimings(alignment);
    wordTimingsRef.current = wordTimings;

    if (wordTimings.length) {
      startHighlightLoop(audio, wordTimings);
    }

    const handleEnded = () => {
      setActiveWordIndex(null);
      if (highlightRafRef.current) {
        cancelAnimationFrame(highlightRafRef.current);
      }

      if (!autoPlayEnabled) return;

      const currentIndex = visibleBubbles.findIndex((b) => b.id === bubble.id);
      const hasNext =
        currentIndex !== -1 && currentIndex < visibleBubbles.length - 1;
      if (!hasNext) return; // stop at end of page

      const nextBubble = visibleBubbles[currentIndex + 1];
      if (!nextBubble) return;

      autoPlayTimerRef.current = setTimeout(() => {
        setSelectedBubbleId(nextBubble.id);
        playBubble(nextBubble);
      }, 400);
    };

    audio.addEventListener("ended", handleEnded);

    audio.play().catch((err) => {
      console.error("Audio playback failed", err);
    });
  };

  const handleBubbleClick = (bubble: Bubble) => {
    if (selectedBubbleId === bubble.id) {
      if (audioRef.current) {
        if (audioRef.current.paused) {
          audioRef.current.play().catch(console.error);
        } else {
          audioRef.current.pause();
        }
      } else {
        playBubble(bubble);
      }
    } else {
      setSelectedBubbleId(bubble.id);
      playBubble(bubble);
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    const pointers = pointerMapRef.current;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    if (pointers.size === 1 && scale === 1) {
      swipeStartRef.current = e.clientX;
    }

    if (pointers.size === 2) {
      const values = Array.from(pointers.values());
      if (values.length === 2) {
        const [first, second] = values as [
          { x: number; y: number },
          { x: number; y: number },
        ];
        initialPinchRef.current = {
          distance: distanceBetween(first, second),
          scale,
        };
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const pointers = pointerMapRef.current;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2 && initialPinchRef.current) {
      const values = Array.from(pointers.values());
      if (values.length === 2) {
        const [first, second] = values as [
          { x: number; y: number },
          { x: number; y: number },
        ];
        const newDistance = distanceBetween(first, second);
        const ratio = newDistance / (initialPinchRef.current.distance || 1);
        const nextScale = clampScale(initialPinchRef.current.scale * ratio);
        setScale(nextScale);
        return;
      }
    }

    if (pointers.size === 1 && scale > 1 && prev) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      setOffset((current) => ({
        x: clampOffset(current.x + dx),
        y: clampOffset(current.y + dy),
      }));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const pointers = pointerMapRef.current;
    const isPinch = pointers.size === 2;

    pointers.delete(e.pointerId);

    if (pointers.size < 2) {
      initialPinchRef.current = null;
    }

    if (!isPinch && scale === 1 && swipeStartRef.current !== null) {
      const delta = e.clientX - swipeStartRef.current;
      if (delta > MIN_SWIPE_DISTANCE && prevPageLink) {
        router.push(prevPageLink);
      }
      if (delta < -MIN_SWIPE_DISTANCE && nextPageLink) {
        router.push(nextPageLink);
      }
    }

    swipeStartRef.current = null;
  };

  const resetView = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-black">
      <div className="relative flex flex-1 items-center justify-center overflow-hidden p-4">
        <div
          className="relative flex h-full w-full touch-none items-center justify-center"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
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
                  onClick={(evt) => {
                    evt.stopPropagation();
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

      <div className="z-50 flex h-[96px] shrink-0 items-center gap-3 border-t border-neutral-800 bg-neutral-950/95 px-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <Link
            href={`/book/${bookId}`}
            className="rounded-full p-2 text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Library"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </Link>
          <button
            onClick={() => setIsPageSheetOpen(true)}
            className="rounded-full p-2 text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Open page selector"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="7" height="7" x="3" y="3" rx="1" />
              <rect width="7" height="7" x="14" y="3" rx="1" />
              <rect width="7" height="7" x="14" y="14" rx="1" />
              <rect width="7" height="7" x="3" y="14" rx="1" />
            </svg>
          </button>
        </div>

        <SpeechBox
          bubble={selectedBubble}
          alignment={
            selectedBubble
              ? (timestamps[selectedBubble.id]?.normalized_alignment ??
                timestamps[selectedBubble.id]?.alignment ??
                null)
              : null
          }
          activeWordIndex={activeWordIndex}
          className="flex-1"
        />

        <div className="flex items-center gap-3">
          <div className="rounded-full bg-neutral-800 px-3 py-1 text-xs font-semibold text-neutral-200">
            Page {pageNumber} / {pageCount}
          </div>
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="rounded-full p-2 text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Open settings"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c0 .27.11.52.29.71.19.19.44.29.71.29H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>
        </div>
      </div>

      <PageSelectorSheet
        open={isPageSheetOpen}
        onClose={() => setIsPageSheetOpen(false)}
        currentPage={pageNumber}
        pageCount={pageCount}
        bookId={bookId}
        issueId={issueId}
      />

      <SettingsSheet
        open={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        autoPlayEnabled={autoPlayEnabled}
        onToggleAutoPlay={() => setAutoPlayEnabled((prev) => !prev)}
        prevPageLink={prevPageLink}
        nextPageLink={nextPageLink}
      />

      {scale > 1 && (
        <button
          onClick={resetView}
          className="absolute top-4 right-4 z-50 rounded-full bg-neutral-900/80 px-3 py-1 text-xs font-semibold text-neutral-200 shadow-lg backdrop-blur hover:bg-neutral-800"
        >
          Reset View
        </button>
      )}
    </div>
  );
}
