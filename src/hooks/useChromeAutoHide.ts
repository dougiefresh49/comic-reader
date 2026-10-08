"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const AUTO_HIDE_DELAY_MS = 3000;

export function useChromeAutoHide(opts?: { disabled?: boolean }) {
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sheetOpenRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    if (opts?.disabled || sheetOpenRef.current) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      setVisible(false);
    }, AUTO_HIDE_DELAY_MS);
  }, [opts?.disabled, clearTimer]);

  const show = useCallback(() => {
    setVisible(true);
    startTimer();
  }, [startTimer]);

  const toggle = useCallback(() => {
    setVisible((prev) => {
      const next = !prev;
      if (next) startTimer();
      return next;
    });
  }, [startTimer]);

  const lockVisible = useCallback(
    (locked: boolean) => {
      const wasLocked = sheetOpenRef.current;
      sheetOpenRef.current = locked;
      if (locked) {
        clearTimer();
        setVisible(true);
        return;
      }
      // A bar left up after a sheet closes covers bubbles at the top of the page (#636).
      if (wasLocked && !opts?.disabled) {
        clearTimer();
        setVisible(false);
      }
    },
    [clearTimer, opts?.disabled],
  );

  useEffect(() => {
    if (opts?.disabled) {
      setVisible(true);
      clearTimer();
      return;
    }
    startTimer();
    return clearTimer;
  }, [opts?.disabled, startTimer, clearTimer]);

  return {
    chromeVisible: visible,
    showChrome: show,
    toggleChrome: toggle,
    lockChrome: lockVisible,
  };
}
