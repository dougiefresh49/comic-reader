"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** A tab switch fires both `visibilitychange` and `focus`; returns closer than this are one return. */
const RETURN_COALESCE_MS = 1000;

/**
 * Re-runs the server component, so counts and durations move without a page
 * reload and a Start, Resume or Retry pressed on this page shows up. Renders
 * nothing.
 *
 * `intervalMs` refreshes on an interval, skipping ticks while the tab is
 * hidden; null means nothing polls. `refreshOnReturn` refreshes once each
 * time the tab comes back (visible again or the window regains focus),
 * whether or not an interval runs, so a change made in another tab shows up
 * on return.
 */
export function LiveRefresh({
  intervalMs,
  refreshOnReturn = false,
}: {
  intervalMs: number | null;
  refreshOnReturn?: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    if (intervalMs === null) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, router]);

  useEffect(() => {
    if (!refreshOnReturn) return;
    let lastReturn = 0;
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastReturn < RETURN_COALESCE_MS) return;
      lastReturn = now;
      router.refresh();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [refreshOnReturn, router]);

  return null;
}
