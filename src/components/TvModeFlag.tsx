"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  resolveTvMode,
  TV_MODE_CLASS,
  TV_MODE_SESSION_KEY,
} from "~/lib/tv-mode";

function readStored(): string | null {
  try {
    return sessionStorage.getItem(TV_MODE_SESSION_KEY);
  } catch {
    return null;
  }
}

function writeStored(value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(TV_MODE_SESSION_KEY);
    else sessionStorage.setItem(TV_MODE_SESSION_KEY, value);
  } catch {
    // Storage blocked: the flag still follows the URL for this page.
  }
}

/**
 * Sets the TV layout class on <html> after mount (#951): on a TV user agent,
 * or for the session after `?tv=1`. Client-side only, so no page turns
 * dynamic and the server HTML never differs.
 */
export function TvModeFlag() {
  const pathname = usePathname();
  useEffect(() => {
    const stored = readStored();
    const { on, stored: next } = resolveTvMode(
      navigator.userAgent,
      new URLSearchParams(window.location.search).get("tv"),
      stored,
    );
    if (next !== stored) writeStored(next);
    document.documentElement.classList.toggle(TV_MODE_CLASS, on);
  }, [pathname]);
  return null;
}
