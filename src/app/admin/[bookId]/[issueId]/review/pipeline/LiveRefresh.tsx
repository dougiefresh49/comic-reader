"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-runs the server component on an interval, so counts and durations move
 * without a page reload and a Start, Resume or Retry pressed on this page
 * shows up. `intervalMs` null means the run is done and nothing polls.
 * Renders nothing. Pauses while the tab is hidden.
 */
export function LiveRefresh({ intervalMs }: { intervalMs: number | null }) {
  const router = useRouter();

  useEffect(() => {
    if (intervalMs === null) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, router]);

  return null;
}
