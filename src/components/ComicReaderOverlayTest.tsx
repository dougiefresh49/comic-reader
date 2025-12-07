"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import type { Bubble, CharacterAlignment, AudioTimestamps } from "~/types";

interface ComicReaderOverlayTestProps {
  pageImage: string;
  bubbles: Bubble[];
  timestamps: Record<string, AudioTimestamps>;
  bookId: string;
  issueId: string;
}

export default function ComicReaderOverlayTest({
  pageImage,
  bubbles,
  timestamps,
  bookId,
  issueId,
}: ComicReaderOverlayTestProps) {
  const [selectedBubbleId, setSelectedBubbleId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [highlightedRange, setHighlightedRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const imageContainerRef = useRef<HTMLDivElement | null>(null);

  // Filter out ignored bubbles and non-speech bubbles, then sort by index
  const visibleBubbles = bubbles
    .filter(
      (b) =>
        !b.ignored &&
        (b.type === "SPEECH" ||
          b.type === "NARRATION" ||
          b.type === "CAPTION") &&
        b.style, // Only show bubbles with style data
    )
    .sort((a, b) => (a.box_2d.index ?? 0) - (b.box_2d.index ?? 0));

  const selectedBubble = visibleBubbles.find((b) => b.id === selectedBubbleId);

  // Play selected bubble
  const playBubble = (bubble: Bubble) => {
    // Stop any currently playing audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }

    setIsPlaying(true);
    setHighlightedRange(null);

    // Load and play audio
    const audioUrl = `/comics/${bookId}/${issueId}/audio/${bubble.id}.mp3`;
    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    // Get timestamps for this bubble
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
      // Set up highlighting based on timestamps
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

        // Find which character range should be highlighted
        for (let i = 0; i < starts.length; i++) {
          const startTime = starts[i] ?? 0;
          const endTime = ends[i] ?? 0;

          if (currentTime >= startTime && currentTime <= endTime) {
            setHighlightedRange({ start: i, end: i });
            break;
          }
        }
      };

      // Update highlight during playback
      intervalId = setInterval(updateHighlight, 50); // Update every 50ms

      const handleEnded = () => {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
        setIsPlaying(false);
        setHighlightedRange(null);
      };

      audio.addEventListener("ended", handleEnded);
    } else {
      // No timestamps available, just play audio without highlighting
      audio.addEventListener("ended", () => {
        setIsPlaying(false);
      });
    }

    audio.addEventListener("pause", () => {
      setIsPlaying(false);
    });

    audio.addEventListener("play", () => {
      setIsPlaying(true);
    });

    audio.play().catch((error) => {
      console.error("Error playing audio:", error);
      setIsPlaying(false);
    });
  };

  // Handle bubble click
  const handleBubbleClick = (bubble: Bubble) => {
    if (selectedBubbleId === bubble.id) {
      // If already selected, toggle play/pause
      if (audioRef.current) {
        if (audioRef.current.paused) {
          audioRef.current.play();
        } else {
          audioRef.current.pause();
        }
      } else {
        // Start playing
        playBubble(bubble);
      }
    } else {
      // Select new bubble and start playing
      setSelectedBubbleId(bubble.id);
      playBubble(bubble);
    }
  };

  // Pause audio
  const pauseAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  };

  // Render text with highlighting
  const renderTextWithHighlight = (bubble: Bubble) => {
    const bubbleTimestamps = timestamps[bubble.id];
    const alignment =
      bubbleTimestamps?.normalized_alignment ?? bubbleTimestamps?.alignment;
    const text = bubble.textWithCues ?? bubble.ocr_text;

    if (!alignment || !highlightedRange) {
      return <span>{text}</span>;
    }

    // Build highlighted text
    const chars = alignment.characters;
    const result: React.ReactNode[] = [];
    let textIndex = 0;

    for (let i = 0; i < chars.length; i++) {
      const char = chars[i] ?? "";
      const isHighlighted =
        i >= highlightedRange.start && i <= highlightedRange.end;

      // Try to match character from alignment to text
      if (textIndex < text.length) {
        if (text[textIndex] === char || char === " ") {
          result.push(
            <span
              key={i}
              className={isHighlighted ? "bg-yellow-400 text-black" : ""}
            >
              {text[textIndex]}
            </span>,
          );
          textIndex++;
        } else {
          // Character mismatch, just show the alignment char
          result.push(
            <span
              key={i}
              className={isHighlighted ? "bg-yellow-400 text-black" : ""}
            >
              {char}
            </span>,
          );
        }
      } else {
        result.push(
          <span
            key={i}
            className={isHighlighted ? "bg-yellow-400 text-black" : ""}
          >
            {char}
          </span>,
        );
      }
    }

    return <>{result}</>;
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  return (
    <div className="relative flex flex-col items-center gap-4">
      {/* Comic Page Image with Overlays */}
      <div
        ref={imageContainerRef}
        className="relative aspect-[2/3] w-full max-w-2xl"
      >
        <Image
          src={pageImage}
          alt="Comic page"
          fill
          className="object-contain"
          priority
          sizes="(max-width: 768px) 100vw, 768px"
        />

        {/* Bubble Overlays */}
        {visibleBubbles.map((bubble) => {
          if (!bubble.style) return null;

          const isSelected = selectedBubbleId === bubble.id;
          const isActive = isSelected && isPlaying;

          return (
            <button
              key={bubble.id}
              type="button"
              onClick={() => handleBubbleClick(bubble)}
              className={`absolute cursor-pointer rounded border-2 transition-all ${
                isSelected
                  ? isActive
                    ? "border-yellow-400 bg-yellow-400/20"
                    : "border-blue-400 bg-blue-400/20"
                  : "border-transparent bg-black/30 hover:border-white/50 hover:bg-black/50"
              }`}
              style={{
                left: bubble.style.left,
                top: bubble.style.top,
                width: bubble.style.width,
                height: bubble.style.height,
              }}
              title={bubble.ocr_text}
            >
              {/* Show text when selected */}
              {isSelected && (
                <div className="absolute inset-0 flex items-center justify-center overflow-hidden rounded p-1 text-[10px] font-semibold text-white">
                  {bubble.ocr_text}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Selected Bubble Info and Controls */}
      {selectedBubble && (
        <div className="w-full max-w-2xl rounded-lg bg-gray-900 p-4 text-white">
          {/* Bubble Info */}
          <div className="mb-4">
            <div className="text-sm text-gray-400">
              Bubble{" "}
              {visibleBubbles.findIndex((b) => b.id === selectedBubbleId) + 1}{" "}
              of {visibleBubbles.length}
            </div>
            <div className="mt-1 text-lg font-semibold">
              {selectedBubble.speaker ?? "Narrator"}
            </div>
          </div>

          {/* Text Display */}
          <div className="mb-4 min-h-[60px] rounded bg-black/50 p-3 text-sm">
            {renderTextWithHighlight(selectedBubble)}
          </div>

          {/* Controls */}
          <div className="flex items-center justify-center gap-4">
            {isPlaying ? (
              <button
                onClick={pauseAudio}
                className="rounded bg-red-600 px-6 py-3 font-semibold transition-colors hover:bg-red-700"
              >
                Pause
              </button>
            ) : (
              <button
                onClick={() => playBubble(selectedBubble)}
                className="rounded bg-blue-600 px-6 py-3 font-semibold transition-colors hover:bg-blue-700"
              >
                Play
              </button>
            )}
          </div>
        </div>
      )}

      {/* Debug Info */}
      <div className="w-full max-w-2xl rounded-lg bg-gray-800 p-3 text-xs text-gray-400">
        <div className="mb-2 font-semibold text-white">Debug Info:</div>
        <div>Total bubbles: {bubbles.length}</div>
        <div>Visible bubbles (with style): {visibleBubbles.length}</div>
        <div>Selected bubble: {selectedBubbleId ?? "None"}</div>
        {selectedBubble?.style && (
          <div className="mt-2">
            <div>Style: {JSON.stringify(selectedBubble.style)}</div>
            <div>
              Box 2D: x={selectedBubble.box_2d.x}, y={selectedBubble.box_2d.y},
              w={selectedBubble.box_2d.width}, h={selectedBubble.box_2d.height}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
