"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

export function useWordHighlight() {
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);
  // Mirrors the last value passed to setActiveWordIndex, so the rAF tick
  // sets state once per word instead of once per frame.
  const indexRef = useRef<number | null>(null);

  const stopHighlight = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    indexRef.current = null;
    setActiveWordIndex(null);
  }, []);

  const startHighlight = useCallback(
    (audio: HTMLAudioElement, words: WordTiming[]) => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }

      const tick = () => {
        // Paused: skip the update, so the current word stays highlighted.
        if (!audio.paused && !audio.ended) {
          const idx = findActiveWordIndex(
            words,
            audio.currentTime,
            indexRef.current,
          );
          if (idx !== indexRef.current) {
            indexRef.current = idx;
            setActiveWordIndex(idx);
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    },
    [],
  );

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return { activeWordIndex, startHighlight, stopHighlight };
}
