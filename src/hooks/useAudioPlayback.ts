"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Bubble, AudioTimestamps } from "~/types";
import { audioUrl } from "~/lib/storage";
import { buildWordTimings } from "~/components/zen-comic-reader/text-utils";
import { useWordHighlight } from "./useWordHighlight";

interface UseAudioPlaybackOptions {
  bookId: string;
  issueId: string;
  timestamps: Record<string, AudioTimestamps>;
  onBubbleEnded?: (bubble: Bubble) => void;
  /** 0..1 — applied as audio.volume on every bubble playback. */
  volume?: number;
  /** HTMLMediaElement.playbackRate; pitch-preserved up to ~1.5x in Safari. */
  playbackRate?: number;
}

export function useAudioPlayback({
  bookId,
  issueId,
  timestamps,
  onBubbleEnded,
  volume = 1,
  playbackRate = 1,
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
        audioUrl(
          bookId,
          issueId,
          bubble.audioStoragePath ?? `${bubble.id}.mp3`,
        ),
      );
      audio.volume = Math.max(0, Math.min(1, volume));
      audio.playbackRate = playbackRate;
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
    [
      bookId,
      issueId,
      timestamps,
      startHighlight,
      stopAll,
      stopHighlight,
      volume,
      playbackRate,
    ],
  );

  // Live-update an in-flight audio element when volume/rate change mid-playback.
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = Math.max(0, Math.min(1, volume));
      audioRef.current.playbackRate = playbackRate;
    }
  }, [volume, playbackRate]);

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
