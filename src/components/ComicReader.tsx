"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";

interface Bubble {
  id: string;
  box_2d: {
    index?: number;
  };
  ocr_text: string;
  type: "SPEECH" | "NARRATION" | "CAPTION" | "SFX" | "BACKGROUND";
  speaker: string | null;
  emotion: string;
  textWithCues?: string;
  ignored?: boolean;
}

interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface AudioTimestamps {
  alignment: CharacterAlignment | null;
  normalized_alignment: CharacterAlignment | null;
}

interface ComicReaderProps {
  pageImage: string;
  bubbles: Bubble[];
  timestamps: Record<string, AudioTimestamps>;
  bookId: string;
  issueId: string;
}

export default function ComicReader({
  pageImage,
  bubbles,
  timestamps,
  bookId,
  issueId,
}: ComicReaderProps) {
  const [currentBubbleIndex, setCurrentBubbleIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAutoPlay, setIsAutoPlay] = useState(false);
  const [highlightedRange, setHighlightedRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Filter out ignored bubbles and non-speech bubbles, then sort by index
  const visibleBubbles = bubbles
    .filter(
      (b) =>
        !b.ignored &&
        (b.type === "SPEECH" || b.type === "NARRATION" || b.type === "CAPTION"),
    )
    .sort((a, b) => (a.box_2d.index ?? 0) - (b.box_2d.index ?? 0));

  const currentBubble = visibleBubbles[currentBubbleIndex] ?? null;

  // Play current bubble
  const playCurrentBubble = () => {
    if (!currentBubble) return;

    // Stop any currently playing audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }

    setIsPlaying(true);
    setHighlightedRange(null);

    // Load and play audio
    const audioUrl = `/comics/${bookId}/${issueId}/audio/${currentBubble.id}.mp3`;
    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    // Get timestamps for this bubble
    const bubbleTimestamps = timestamps[currentBubble.id] as
      | {
          alignment?: CharacterAlignment;
          normalized_alignment?: CharacterAlignment;
        }
      | undefined;
    const alignment =
      bubbleTimestamps?.normalized_alignment || bubbleTimestamps?.alignment;

    if (
      alignment &&
      alignment.character_start_times_seconds &&
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
        // Auto-advance to next bubble if auto-play is enabled
        if (isAutoPlay) {
          goToNextBubble();
        }
      };

      audio.addEventListener("ended", handleEnded);
    } else {
      // No timestamps available, just play audio without highlighting
      audio.addEventListener("ended", () => {
        setIsPlaying(false);
        // Auto-advance to next bubble if auto-play is enabled
        if (isAutoPlay) {
          goToNextBubble();
        }
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

  // Go to next bubble
  const goToNextBubble = () => {
    if (currentBubbleIndex < visibleBubbles.length - 1) {
      setCurrentBubbleIndex(currentBubbleIndex + 1);
    } else {
      // Reached the end, stop auto-play
      setIsAutoPlay(false);
    }
  };

  // Pause current audio
  const pauseAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  };

  // Toggle auto-play
  const toggleAutoPlay = () => {
    setIsAutoPlay(!isAutoPlay);
    // If enabling auto-play and not currently playing, start playing
    if (!isAutoPlay && !isPlaying && currentBubble) {
      playCurrentBubble();
    }
  };

  // Go to previous bubble
  const goToPreviousBubble = () => {
    if (currentBubbleIndex > 0) {
      setCurrentBubbleIndex(currentBubbleIndex - 1);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  // Auto-play when bubble changes (if auto-play is enabled)
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setIsPlaying(false);
    setHighlightedRange(null);

    // If auto-play is enabled, automatically play the new bubble
    if (isAutoPlay && currentBubble) {
      // Small delay to ensure audio is stopped
      setTimeout(() => {
        playCurrentBubble();
      }, 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBubbleIndex, isAutoPlay]);

  // Render text with highlighting
  const renderTextWithHighlight = (bubble: Bubble) => {
    const bubbleTimestamps = timestamps[bubble.id];
    const alignment =
      bubbleTimestamps?.normalized_alignment || bubbleTimestamps?.alignment;
    const text = bubble.textWithCues || bubble.ocr_text;

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

  if (!currentBubble) {
    return (
      <div className="flex justify-center">
        <div className="relative aspect-[2/3] w-full max-w-2xl">
          <Image
            src={pageImage}
            alt="Comic page"
            fill
            className="object-contain"
            priority
            sizes="(max-width: 768px) 100vw, 768px"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-center gap-4">
      {/* Comic Page Image */}
      <div className="relative aspect-[2/3] w-full max-w-2xl">
        <Image
          src={pageImage}
          alt="Comic page"
          fill
          className="object-contain"
          priority
          sizes="(max-width: 768px) 100vw, 768px"
        />
      </div>

      {/* Audio Player Controls */}
      <div className="w-full max-w-2xl rounded-lg bg-gray-900 p-4 text-white">
        {/* Bubble Info */}
        <div className="mb-4">
          <div className="text-sm text-gray-400">
            Bubble {currentBubbleIndex + 1} of {visibleBubbles.length}
          </div>
          <div className="mt-1 text-lg font-semibold">
            {currentBubble.speaker || "Narrator"}
          </div>
        </div>

        {/* Text Display */}
        <div className="mb-4 min-h-[60px] rounded bg-black/50 p-3 text-sm">
          {renderTextWithHighlight(currentBubble)}
        </div>

        {/* Controls */}
        <div className="space-y-3">
          {/* Main Play/Pause Controls */}
          <div className="flex items-center justify-between gap-4">
            <button
              onClick={goToPreviousBubble}
              disabled={currentBubbleIndex === 0}
              className="rounded bg-gray-700 px-4 py-2 transition-colors hover:bg-gray-600 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500"
            >
              ← Previous
            </button>

            {isPlaying ? (
              <button
                onClick={pauseAudio}
                className="flex-1 rounded bg-red-600 px-6 py-3 font-semibold transition-colors hover:bg-red-700"
              >
                Pause
              </button>
            ) : (
              <button
                onClick={playCurrentBubble}
                className="flex-1 rounded bg-blue-600 px-6 py-3 font-semibold transition-colors hover:bg-blue-700"
              >
                Play
              </button>
            )}

            <button
              onClick={goToNextBubble}
              disabled={currentBubbleIndex === visibleBubbles.length - 1}
              className="rounded bg-gray-700 px-4 py-2 transition-colors hover:bg-gray-600 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500"
            >
              Next →
            </button>
          </div>

          {/* Auto-play Toggle */}
          <button
            onClick={toggleAutoPlay}
            className={`w-full rounded px-4 py-2 font-medium transition-colors ${
              isAutoPlay
                ? "bg-green-600 hover:bg-green-700"
                : "bg-gray-700 hover:bg-gray-600"
            }`}
          >
            {isAutoPlay ? "⏸ Auto-play ON" : "▶ Auto-play OFF"}
          </button>
        </div>
      </div>
    </div>
  );
}
