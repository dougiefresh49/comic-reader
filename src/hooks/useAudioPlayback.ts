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

/** A bubble has audio exactly when its storage path is set. */
export function hasAudio(
  bubble: Bubble,
): bubble is Bubble & { audioStoragePath: string } {
  return Boolean(bubble.audioStoragePath);
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

      // No audio: stop what was playing and leave no element behind, so a
      // second tap (togglePlayPause) cannot replay the previous bubble's clip.
      // No `ended` either: autoplay never picks such a bubble.
      if (!hasAudio(bubble)) {
        audioRef.current = null;
        return;
      }

      const audio = new Audio(
        audioUrl(bookId, issueId, bubble.audioStoragePath),
      );
      audio.volume = Math.max(0, Math.min(1, volume));
      audio.playbackRate = playbackRate;
      audioRef.current = audio;
      setIsPlaying(true);

      const ts = timestamps[bubble.id];
      const alignment = ts?.normalized_alignment ?? ts?.alignment ?? null;
      const { words } = buildWordTimings(alignment);

      audio.addEventListener("ended", () => {
        stopHighlight();
        setIsPlaying(false);
        onBubbleEndedRef.current?.(bubble);
      });
      audio.addEventListener("pause", () => setIsPlaying(false));
      // Every start (first play, replay after `ended`, resume) restarts the
      // highlight loop. `play` events are queued, so one from a clip that
      // stopAll already replaced must not take the loop from the current clip.
      audio.addEventListener("play", () => {
        setIsPlaying(true);
        if (words.length && audioRef.current === audio) {
          startHighlight(audio, words);
        }
      });

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
