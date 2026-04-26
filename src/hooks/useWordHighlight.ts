"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WordTiming } from "~/components/zen-comic-reader/text-utils";

export function useWordHighlight() {
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopHighlight = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setActiveWordIndex(null);
  }, []);

  const startHighlight = useCallback(
    (audio: HTMLAudioElement, words: WordTiming[]) => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }

      const tick = () => {
        if (!audio.paused && !audio.ended) {
          const t = audio.currentTime;
          const idx = words.findIndex((w) => t >= w.start && t <= w.end);
          setActiveWordIndex(idx === -1 ? null : idx);
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
