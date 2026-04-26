"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Bubble, AudioTimestamps } from "~/types";
import { buildWordTimings } from "~/components/zen-comic-reader/text-utils";
import { useWordHighlight } from "./useWordHighlight";

interface UseAudioPlaybackOptions {
  bookId: string;
  issueId: string;
  timestamps: Record<string, AudioTimestamps>;
  onBubbleEnded?: (bubble: Bubble) => void;
}

export function useAudioPlayback({
  bookId,
  issueId,
  timestamps,
  onBubbleEnded,
}: UseAudioPlaybackOptions) {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onBubbleEndedRef = useRef(onBubbleEnded);

  useEffect(() => {
    onBubbleEndedRef.current = onBubbleEnded;
  }, [onBubbleEnded]);

  const { activeWordIndex, startHighlight, stopHighlight } = useWordHighlight();

  const stopAll = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    stopHighlight();
    setIsPlaying(false);
  }, [stopHighlight]);

  const playBubble = useCallback(
    (bubble: Bubble) => {
      stopAll();

      const audio = new Audio(
        `/comics/${bookId}/${issueId}/audio/${bubble.id}.mp3`,
      );
      audioRef.current = audio;
      setIsPlaying(true);

      const ts = timestamps[bubble.id];
      const alignment = ts?.normalized_alignment ?? ts?.alignment ?? null;
      const { words } = buildWordTimings(alignment);
      if (words.length) startHighlight(audio, words);

      audio.addEventListener("ended", () => {
        stopHighlight();
        setIsPlaying(false);
        onBubbleEndedRef.current?.(bubble);
      });
      audio.addEventListener("pause", () => setIsPlaying(false));
      audio.addEventListener("play", () => setIsPlaying(true));

      audio.play().catch((err) => {
        console.error("Audio playback failed", err);
        setIsPlaying(false);
      });
    },
    [bookId, issueId, timestamps, startHighlight, stopAll, stopHighlight],
  );

  const togglePlayPause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio
        .play()
        .then(() => setIsPlaying(true))
        .catch(console.error);
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  }, []);

  useEffect(() => () => stopAll(), [stopAll]);

  return { playBubble, stopAll, togglePlayPause, isPlaying, activeWordIndex };
}
