"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Bubble, AudioTimestamps } from "~/types";
import { audioUrl } from "~/lib/storage";
import {
  applyLevel,
  disconnect,
  ensureConnected,
  resumeContext,
} from "~/lib/audio-graph";
import {
  buildWordTimings,
  type WordTiming,
} from "~/components/zen-comic-reader/text-utils";
import { useWordHighlight, type WordSpan } from "./useWordHighlight";

interface UseAudioPlaybackOptions {
  bookId: string;
  issueId: string;
  timestamps: Record<string, AudioTimestamps>;
  onBubbleEnded?: (bubble: Bubble) => void;
  /**
   * 0..1, applied through the shared Web Audio gain on every bubble
   * playback (`~/lib/audio-graph`), never as `audio.volume`, which iOS
   * WebKit ignores (#611).
   */
  volume?: number;
  /** HTMLMediaElement.playbackRate; pitch-preserved up to ~1.5x in Safari. */
  playbackRate?: number;
}

/** How `playBubble` starts a clip; every field serves joined groups (#451). */
export interface PlayOptions {
  /** Seconds into the clip to start from: a group member's first word. */
  startAt?: number;
  /**
   * The clip's words as the group model chose them. `spans` and `startAt`
   * index into this list, so the highlight must walk the same one.
   */
  words?: WordTiming[];
  /** The group's words per balloon, so the highlight walks between them. */
  spans?: readonly WordSpan[];
}

/**
 * The word list the highlight walks for a clip: the caller's when it chose
 * one (a joined group), else the bubble's own alignment, normalized first.
 */
export function clipWords(
  ts: AudioTimestamps | undefined,
  words?: WordTiming[],
): WordTiming[] {
  return (
    words ??
    buildWordTimings(ts?.normalized_alignment ?? ts?.alignment ?? null).words
  );
}

/** Each loading element's latest seek target, read by its one listener. */
const pendingSeek = new WeakMap<HTMLAudioElement, number>();

/**
 * Moves `audio` to `seconds`. Before the metadata loads the element cannot
 * seek, so the time is set again on `loadedmetadata`; until then the spec
 * keeps it as the default playback start position. Taps while it loads
 * replace the target, and only the last one is applied.
 */
function seekWhenReady(audio: HTMLAudioElement, seconds: number) {
  audio.currentTime = seconds;
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    pendingSeek.delete(audio);
    return;
  }
  const listening = pendingSeek.has(audio);
  pendingSeek.set(audio, seconds);
  if (listening) return;
  audio.addEventListener(
    "loadedmetadata",
    () => {
      const target = pendingSeek.get(audio);
      pendingSeek.delete(audio);
      if (target !== undefined && Math.abs(audio.currentTime - target) > 0.05) {
        audio.currentTime = target;
      }
    },
    { once: true },
  );
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
  // The bubble whose clip audioRef holds, so seekCurrent can reuse it.
  const audioBubbleIdRef = useRef<string | null>(null);
  // Whether the current clip may advance the reader when it fails. stopAll
  // (a page turn, unmount, Reset View) clears it, because pausing an element
  // does not cancel its fetch and the element stays in audioRef, so a late
  // failure must not move the reader. Starting a clip or resuming it sets it.
  const armedRef = useRef(false);
  // The current clip's failure path, so a resume whose play() rejects in
  // togglePlayPause ends the clip the same way its first play() would.
  const failCurrentRef = useRef<((reason: unknown) => void) | null>(null);
  const onBubbleEndedRef = useRef(onBubbleEnded);

  useEffect(() => {
    onBubbleEndedRef.current = onBubbleEnded;
  }, [onBubbleEnded]);

  // Word state lives in a store, not React state here, so a word change
  // re-renders only the leaves subscribed to it (#87).
  const {
    store: wordHighlight,
    startHighlight,
    stopHighlight,
  } = useWordHighlight();

  const stopAll = useCallback(() => {
    armedRef.current = false;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    stopHighlight();
    setIsPlaying(false);
  }, [stopHighlight]);

  const playBubble = useCallback(
    (
      bubble: Bubble,
      { startAt = 0, words: chosenWords, spans }: PlayOptions = {},
    ) => {
      stopAll();
      // Either branch below replaces the current clip for good, so its nodes
      // are unwired here and the element can be collected (#611).
      if (audioRef.current) disconnect(audioRef.current);

      // No audio: stop what was playing and leave no element behind, so a
      // second tap (togglePlayPause) cannot replay the previous bubble's clip.
      // No `ended` either: autoplay never picks such a bubble.
      if (!hasAudio(bubble)) {
        audioRef.current = null;
        audioBubbleIdRef.current = null;
        failCurrentRef.current = null;
        return;
      }

      // crossOrigin before src, so the fetch is a CORS request from the
      // start: createMediaElementSource needs it to route the clip.
      const audio = new Audio();
      audio.crossOrigin = "anonymous";
      audio.src = audioUrl(bookId, issueId, bubble.audioStoragePath);
      const level = Math.max(0, Math.min(1, volume));
      ensureConnected(audio, level);
      applyLevel(audio, level);
      audio.playbackRate = playbackRate;
      audioRef.current = audio;
      audioBubbleIdRef.current = bubble.id;
      armedRef.current = true;
      setIsPlaying(true);

      const words = clipWords(timestamps[bubble.id], chosenWords);

      // A clip that fails to load never fires `ended`, so it is treated as
      // one that ended: the reader moves on through the same callback. A 400
      // or 404 fires both `error` and a NotSupportedError from play(), and
      // `settled` keeps that to one `onBubbleEnded` per clip, and the two
      // guards below drop a failure from a clip that was replaced or stopped.
      let settled = false;
      const failed = (reason: unknown) => {
        if (settled || audioRef.current !== audio || !armedRef.current) return;
        settled = true;
        console.error(
          `Audio clip failed to load for bubble ${bubble.id} (${audio.src})`,
          reason,
        );
        stopHighlight();
        setIsPlaying(false);
        onBubbleEndedRef.current?.(bubble);
      };
      failCurrentRef.current = failed;

      audio.addEventListener("ended", () => {
        settled = true;
        stopHighlight();
        setIsPlaying(false);
        onBubbleEndedRef.current?.(bubble);
      });
      audio.addEventListener("error", () => failed(audio.error));
      audio.addEventListener("pause", () => setIsPlaying(false));
      // Every start (first play, replay after `ended`, resume) restarts the
      // highlight loop. `play` events are queued, so one from a clip that
      // stopAll already replaced must not take the loop from the current clip.
      audio.addEventListener("play", () => {
        setIsPlaying(true);
        if (words.length && audioRef.current === audio) {
          startHighlight(audio, words, bubble.id, spans);
        }
      });

      if (startAt > 0) seekWhenReady(audio, startAt);
      audio.play().catch((err: unknown) => {
        const name = err instanceof DOMException ? err.name : undefined;
        // stopAll paused this clip before play() resolved: it was replaced.
        if (name === "AbortError") return;
        // Autoplay blocked for lack of a gesture. Skipping here would race
        // through the page in silence, so only drop the play state.
        if (name === "NotAllowedError") {
          if (audioRef.current === audio) setIsPlaying(false);
          return;
        }
        failed(err);
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
      applyLevel(audioRef.current, Math.max(0, Math.min(1, volume)));
      audioRef.current.playbackRate = playbackRate;
    }
  }, [volume, playbackRate]);

  // Plays the paused current clip from where it sits. The tap that calls
  // this is a gesture, so a context that was interrupted or suspended while
  // the clip sat paused resumes here (#611).
  const resume = useCallback((audio: HTMLAudioElement) => {
    armedRef.current = true;
    resumeContext();
    audio
      .play()
      .then(() => setIsPlaying(true))
      .catch((err: unknown) => {
        const name = err instanceof DOMException ? err.name : undefined;
        if (name === "AbortError" || name === "NotAllowedError") {
          console.error("Audio resume failed", err);
          return;
        }
        failCurrentRef.current?.(err);
      });
  }, []);

  const togglePlayPause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      resume(audio);
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  }, [resume]);

  /**
   * Moves the loaded clip to `seconds` and plays it, when that clip is
   * `bubbleId`'s and has not failed: a tap on another balloon of the joined
   * group playing (#451) jumps without reloading. False when there is no
   * such clip; the caller then starts one with `playBubble`.
   */
  const seekCurrent = useCallback(
    (bubbleId: string, seconds: number): boolean => {
      const audio = audioRef.current;
      if (!audio || audioBubbleIdRef.current !== bubbleId || audio.error) {
        return false;
      }
      seekWhenReady(audio, seconds);
      if (audio.paused) resume(audio);
      return true;
    },
    [resume],
  );

  // Unmount lets go of the clip for good: pause it and unwire its nodes, or
  // the last clip of every page stays on the shared destination (#611).
  useEffect(
    () => () => {
      stopAll();
      if (audioRef.current) disconnect(audioRef.current);
    },
    [stopAll],
  );

  return {
    playBubble,
    seekCurrent,
    stopAll,
    togglePlayPause,
    isPlaying,
    wordHighlight,
  };
}
