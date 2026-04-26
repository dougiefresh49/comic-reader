"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Bubble } from "~/types";

export function useAutoPlay(
  visibleBubbles: Bubble[],
  autoPlayEnabled: boolean,
  play: (bubble: Bubble) => void,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef(autoPlayEnabled);
  const playRef = useRef(play);

  useEffect(() => {
    enabledRef.current = autoPlayEnabled;
  }, [autoPlayEnabled]);

  useEffect(() => {
    playRef.current = play;
  }, [play]);

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleNext = useCallback(
    (endedBubble: Bubble) => {
      if (!enabledRef.current) return;
      const idx = visibleBubbles.findIndex((b) => b.id === endedBubble.id);
      const next = visibleBubbles[idx + 1];
      if (!next) return;
      timerRef.current = setTimeout(() => {
        playRef.current(next);
      }, 400);
    },
    [visibleBubbles],
  );

  useEffect(() => () => cancelPending(), [cancelPending]);

  return { scheduleNext, cancelPending };
}
