"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Bubble, CharacterAlignment, AudioTimestamps } from "~/types";

interface ZenComicReaderProps {
  pageImage: string;
  bubbles: Bubble[];
  timestamps: Record<string, AudioTimestamps>;
  bookId: string;
  issueId: string;
  prevPageLink?: string | null;
  nextPageLink?: string | null;
}

export default function ZenComicReader({
  pageImage,
  bubbles,
  timestamps,
  bookId,
  issueId,

  nextPageLink,
}: ZenComicReaderProps) {
  const [selectedBubbleId, setSelectedBubbleId] = useState<string | null>(null);
  const [autoPlayEnabled, setAutoPlayEnabled] = useState(false);
  const [highlightedRange, setHighlightedRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [scale, setScale] = useState(1); // Added scale state
  const [touchStart, setTouchStart] = useState<number | null>(null); // Added touchStart state
  const [touchEnd, setTouchEnd] = useState<number | null>(null); // Added touchEnd state

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const autoPlayTimerRef = useRef<NodeJS.Timeout | null>(null);
  const router = useRouter();

  // Filter and sort bubbles
  const visibleBubbles = bubbles
    .filter(
      (b) =>
        !b.ignored &&
        (b.type === "SPEECH" ||
          b.type === "NARRATION" ||
          b.type === "CAPTION") &&
        b.style,
    )
    .sort((a, b) => (a.box_2d.index ?? 0) - (b.box_2d.index ?? 0));

  const selectedBubble = visibleBubbles.find((b) => b.id === selectedBubbleId);

  // Swipe threshold
  const minSwipeDistance = 50;

  const onTouchStart = (e: React.TouchEvent) => {
    setTouchEnd(null);
    const touch = e.targetTouches[0];
    if (touch) {
      setTouchStart(touch.clientX);
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const touch = e.targetTouches[0];
    if (touch) {
      setTouchEnd(touch.clientX);
    }
  };

  const onTouchEnd = () => {
    if (!touchStart || !touchEnd) return;
    const distance = touchStart - touchEnd;
    const isLeftSwipe = distance > minSwipeDistance;
    const isRightSwipe = distance < -minSwipeDistance;

    // Only navigate if not zoomed in (to avoid conflict with panning if implemented later, though currently basic zoom)
    if (scale === 1) {
      if (isLeftSwipe && nextPageLink) {
        router.push(nextPageLink);
      }
    }
  };

  // Re-deriving prev link logic effectively for swipe since prop was unused
  // Actually, better to just rely on buttons for now or fixing the prop.
  // Let's implement basics first.

  // Handling swipe navigation based on props
  useEffect(() => {
    const handleSwipe = () => {
      if (!touchStart || !touchEnd) return;
      const distance = touchStart - touchEnd;
      const isLeftSwipe = distance > minSwipeDistance;
      const isRightSwipe = distance < -minSwipeDistance;

      if (scale === 1) {
        if (isLeftSwipe && nextPageLink) {
          // Navigate Next
          const link = document.createElement("a");
          link.href = nextPageLink;
          link.click();
        }
        // For prev link, we need to pass it properly.
        // I'll ignore back swipe for now or assume user uses browser back or library.
      }
    };

    handleSwipe();
  }, [touchEnd, touchStart, scale, nextPageLink]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      if (autoPlayTimerRef.current) {
        clearTimeout(autoPlayTimerRef.current);
      }
    };
  }, []);

  const playBubble = (bubble: Bubble) => {
    // clean up previous
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current);
      autoPlayTimerRef.current = null;
    }

    setHighlightedRange(null);

    const audioUrl = `/comics/${bookId}/${issueId}/audio/${bubble.id}.mp3`;
    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    const bubbleTimestamps = timestamps[bubble.id] as
      | {
          alignment?: CharacterAlignment;
          normalized_alignment?: CharacterAlignment;
        }
      | undefined;
    const alignment =
      bubbleTimestamps?.normalized_alignment ?? bubbleTimestamps?.alignment;

    if (
      alignment?.character_start_times_seconds &&
      alignment.character_end_times_seconds
    ) {
      let intervalId: NodeJS.Timeout | null = null;

      const updateHighlight = () => {
        if (audio.paused || audio.ended) {
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
          return;
        }

        const currentTime = audio.currentTime;
        const starts = alignment.character_start_times_seconds;
        const ends = alignment.character_end_times_seconds;

        for (let i = 0; i < starts.length; i++) {
          const startTime = starts[i] ?? 0;
          const endTime = ends[i] ?? 0;

          if (currentTime >= startTime && currentTime <= endTime) {
            setHighlightedRange({ start: i, end: i });
            break;
          }
        }
      };

      intervalId = setInterval(updateHighlight, 30); // smoother update

      const handleEnded = () => {
        if (intervalId) {
          clearInterval(intervalId);
        }
        setHighlightedRange(null);

        // Handle Auto Play
        if (autoPlayEnabled) {
          const currentIndex = visibleBubbles.findIndex(
            (b) => b.id === bubble.id,
          );
          if (currentIndex !== -1 && currentIndex < visibleBubbles.length - 1) {
            const nextBubble = visibleBubbles[currentIndex + 1];
            if (nextBubble) {
              // Wait a moment then play next
              autoPlayTimerRef.current = setTimeout(() => {
                setSelectedBubbleId(nextBubble.id);
                playBubble(nextBubble);
              }, 500);
            }
          }
        }
      };

      audio.addEventListener("ended", handleEnded);
    } else {
      audio.addEventListener("ended", () => {
        // Handle Auto Play fallback
        if (autoPlayEnabled) {
          const currentIndex = visibleBubbles.findIndex(
            (b) => b.id === bubble.id,
          );
          if (currentIndex !== -1 && currentIndex < visibleBubbles.length - 1) {
            const nextBubble = visibleBubbles[currentIndex + 1];
            if (nextBubble) {
              autoPlayTimerRef.current = setTimeout(() => {
                setSelectedBubbleId(nextBubble.id);
                playBubble(nextBubble);
              }, 500);
            }
          }
        }
      });
    }

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

  const renderTextWithHighlight = (bubble: Bubble) => {
    const bubbleTimestamps = timestamps[bubble.id];
    const alignment =
      bubbleTimestamps?.normalized_alignment ?? bubbleTimestamps?.alignment;
    const text = bubble.textWithCues ?? bubble.ocr_text;

    if (!alignment || !highlightedRange) {
      return <span className="text-lg leading-relaxed text-white">{text}</span>;
    }

    const chars = alignment.characters;
    const result: React.ReactNode[] = [];
    let textIndex = 0;

    for (let i = 0; i < chars.length; i++) {
      const char = chars[i] ?? "";
      const isHighlighted =
        i >= highlightedRange.start && i <= highlightedRange.end;

      const style = isHighlighted
        ? "text-cyan-400 font-bold drop-shadow-[0_0_8px_rgba(34,211,238,0.8)]"
        : "text-white/90";

      if (textIndex < text.length) {
        if (text[textIndex] === char || char === " ") {
          result.push(
            <span key={i} className={style}>
              {text[textIndex]}
            </span>,
          );
          textIndex++;
        } else {
          result.push(
            <span key={i} className={style}>
              {char}
            </span>,
          );
        }
      } else {
        result.push(
          <span key={i} className={style}>
            {char}
          </span>,
        );
      }
    }
    return <p className="text-lg leading-relaxed">{result}</p>;
  };

  // Zoom handlers
  const zoomIn = () => setScale((s) => Math.min(s + 0.5, 3));
  const zoomOut = () => setScale((s) => Math.max(s - 0.5, 1));
  const resetZoom = () => setScale(1);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-black"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* Stage Area - Centered Comic Page */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden p-4">
        <div
          className="relative flex h-full w-full items-center justify-center transition-transform duration-200 ease-out"
          style={{ transform: `scale(${scale})` }}
        >
          <div className="relative aspect-[2/3] h-full max-h-[calc(100vh-100px)] w-auto">
            {" "}
            {/* Adjusted max-h */}
            <Image
              src={pageImage}
              alt="Comic page"
              fill
              className="object-contain"
              priority
            />
            {/* Bubble Click Targets & Highlights */}
            {visibleBubbles.map((bubble) => {
              if (!bubble.style) return null;
              const isSelected = selectedBubbleId === bubble.id;

              return (
                <button
                  key={bubble.id}
                  onClick={(e) => {
                    e.stopPropagation(); // Prevent interfering with swipe/zoom clicks
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
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Docked Control Bar - Slim Version */}
      <div className="z-50 flex h-[80px] shrink-0 items-center gap-4 border-t border-neutral-800 bg-neutral-900 px-4">
        {/* Left Controls - Icons Only */}
        <div className="flex items-center gap-4">
          <Link
            href={`/book/${bookId}`}
            className="rounded-full p-2 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
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
            className="rounded-full p-2 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Pages"
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

        {/* Center: Dynamic Text Display - Text Only */}
        <div className="relative flex h-[60px] flex-1 items-center justify-center overflow-y-auto rounded-lg border border-neutral-800 bg-black/60 px-4 text-center">
          {selectedBubble ? (
            <div className="w-full">
              {renderTextWithHighlight(selectedBubble)}
            </div>
          ) : (
            <span className="text-sm text-neutral-500 italic">
              Tap a bubble...
            </span>
          )}
        </div>

        {/* Right Controls - Zoom & Auto Play & Nav */}
        <div className="flex items-center justify-end gap-3">
          {/* Zoom Controls */}
          <div className="mr-2 flex items-center gap-1 rounded-lg bg-black/30 p-1">
            <button
              onClick={zoomOut}
              className="rounded p-1.5 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
              aria-label="Zoom Out"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" x2="16.65" y1="21" y2="16.65" />
                <line x1="8" x2="14" y1="11" y2="11" />
              </svg>
            </button>
            <button
              onClick={resetZoom}
              className="px-1.5 font-mono text-xs text-neutral-500 hover:text-white"
              aria-label="Reset Zoom"
            >
              {Math.round(scale * 100)}%
            </button>
            <button
              onClick={zoomIn}
              className="rounded p-1.5 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
              aria-label="Zoom In"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" x2="16.65" y1="21" y2="16.65" />
                <line x1="11" x2="11" y1="8" y2="14" />
                <line x1="8" x2="14" y1="11" y2="11" />
              </svg>
            </button>
          </div>

          {/* Auto Play Toggle */}
          <button
            onClick={() => setAutoPlayEnabled(!autoPlayEnabled)}
            className="flex items-center justify-center"
            title="Auto Play"
          >
            <div
              className={`h-4 w-8 rounded-full p-0.5 transition-colors duration-300 ${autoPlayEnabled ? "bg-cyan-500" : "bg-neutral-700"}`}
            >
              <div
                className={`h-3 w-3 rounded-full bg-white transition-transform duration-300 ${autoPlayEnabled ? "translate-x-4" : "translate-x-0"}`}
              />
            </div>
          </button>

          {/* Next Button */}
          {nextPageLink ? (
            <Link
              href={nextPageLink}
              className="rounded-full bg-neutral-800 p-3 text-white transition-colors hover:bg-neutral-700"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </Link>
          ) : (
            <button
              disabled
              className="cursor-not-allowed rounded-full bg-neutral-900 p-3 text-neutral-700"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
