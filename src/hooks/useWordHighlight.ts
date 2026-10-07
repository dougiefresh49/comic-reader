"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { WordTiming } from "~/components/zen-comic-reader/text-utils";

/**
 * The karaoke rule: the active word is the last word whose `start <= t`, so
 * the highlight holds through the gaps between words. `words` must be sorted
 * by `start`. The search walks forward from `prev`; when `t` is before
 * `prev`'s start (a seek backwards) it restarts from the first word.
 * Returns null before the first word starts.
 */
export function findActiveWordIndex(
  words: readonly Pick<WordTiming, "start">[],
  t: number,
  prev: number | null,
): number | null {
  const startOf = (i: number) => words[i]?.start ?? Infinity;
  let i = prev !== null && startOf(prev) <= t ? prev : 0;
  if (startOf(i) > t) return null;
  while (startOf(i + 1) <= t) i++;
  return i;
}

/** What the playing clip is doing, as the word highlight sees it. */
export type WordHighlightSnapshot = Readonly<{
  /** The bubble whose clip drives the highlight; null when nothing plays. */
  bubbleId: string | null;
  /** Index into that bubble's `buildWordTimings` words; null before the first. */
  index: number | null;
  /** The clip is paused mid-bubble (the highlight holds). */
  paused: boolean;
  /** The clip's `playbackRate`. */
  rate: number;
}>;

const IDLE: WordHighlightSnapshot = {
  bubbleId: null,
  index: null,
  paused: false,
  rate: 1,
};

/**
 * The word state as a small external store, so only the leaves that show a
 * word (the caption, the in-bubble overlay) re-render per word and the
 * reader that owns playback does not (#87). Read it with
 * `useWordHighlightSelector`.
 */
export interface WordHighlightStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => WordHighlightSnapshot;
}

function createWordHighlightStore() {
  let snapshot = IDLE;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    set(next: WordHighlightSnapshot) {
      if (
        next.bubbleId === snapshot.bubbleId &&
        next.index === snapshot.index &&
        next.paused === snapshot.paused &&
        next.rate === snapshot.rate
      ) {
        return;
      }
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  };
}

/**
 * Subscribes to one slice of the word state. Return a primitive from
 * `select`, so the caller re-renders only when that slice changes.
 */
export function useWordHighlightSelector<T>(
  store: WordHighlightStore,
  select: (snapshot: WordHighlightSnapshot) => T,
): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getSnapshot()),
    () => select(IDLE),
  );
}

/** The active word index when `bubbleId` is the bubble playing, else null. */
export function useActiveWordIndex(
  store: WordHighlightStore,
  bubbleId: string | null | undefined,
): number | null {
  return useWordHighlightSelector(store, (s) =>
    bubbleId != null && s.bubbleId === bubbleId ? s.index : null,
  );
}

export function useWordHighlight() {
  const [store] = useState(createWordHighlightStore);
  const rafRef = useRef<number | null>(null);

  const stopHighlight = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    store.set(IDLE);
  }, [store]);

  const startHighlight = useCallback(
    (audio: HTMLAudioElement, words: WordTiming[], bubbleId: string) => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }

      // The store only notifies on a change, so this per-frame tick costs a
      // render once per word (or per pause, resume or rate change).
      const tick = () => {
        const prev = store.getSnapshot();
        const paused = audio.paused && !audio.ended;
        store.set({
          bubbleId,
          // Paused: keep the index, so the current word stays highlighted.
          index:
            audio.paused || audio.ended
              ? prev.bubbleId === bubbleId
                ? prev.index
                : null
              : findActiveWordIndex(
                  words,
                  audio.currentTime,
                  prev.bubbleId === bubbleId ? prev.index : null,
                ),
          paused,
          rate: audio.playbackRate,
        });
        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    },
    [store],
  );

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const readStore: WordHighlightStore = store;
  return { store: readStore, startHighlight, stopHighlight };
}
