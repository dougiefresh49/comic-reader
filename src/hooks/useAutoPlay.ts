"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Bubble } from "~/types";

export function useAutoPlay(
  visibleBubbles: Bubble[],
  autoPlayEnabled: boolean,
  play: (bubble: Bubble) => void,
  onPageEnd?: () => void,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while a gap timer is scheduled, so a "being read" control does not
  // flash to play between bubbles.
  const [pending, setPending] = useState(false);
  const enabledRef = useRef(autoPlayEnabled);
  const playRef = useRef(play);
  const onPageEndRef = useRef(onPageEnd);

  useEffect(() => {
    enabledRef.current = autoPlayEnabled;
  }, [autoPlayEnabled]);

  useEffect(() => {
    playRef.current = play;
  }, [play]);

  useEffect(() => {
    onPageEndRef.current = onPageEnd;
  }, [onPageEnd]);

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPending(false);
  }, []);

  const scheduleNext = useCallback(
    (endedBubble: Bubble) => {
      if (!enabledRef.current) return;
      const idx = visibleBubbles.findIndex((b) => b.id === endedBubble.id);
      const next = visibleBubbles[idx + 1];
      setPending(true);
      if (next) {
        timerRef.current = setTimeout(() => {
          setPending(false);
          playRef.current(next);
        }, 400);
      } else {
        timerRef.current = setTimeout(() => {
          setPending(false);
          onPageEndRef.current?.();
        }, 800);
      }
    },
    [visibleBubbles],
  );

  useEffect(() => () => cancelPending(), [cancelPending]);

  return { scheduleNext, cancelPending, pending };
}
