"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-runs the server component on an interval while the run is live, so the
 * counts and durations move without a page reload. Renders nothing. Pauses
 * while the tab is hidden.
 */
export function LiveRefresh({
  live,
  intervalMs = 5000,
}: {
  live: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [live, intervalMs, router]);

  return null;
}
