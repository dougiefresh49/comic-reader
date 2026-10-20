"use client";

import { useSyncExternalStore } from "react";
import { TV_MODE_CLASS } from "~/lib/tv-mode";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

const getSnapshot = () =>
  document.documentElement.classList.contains(TV_MODE_CLASS);

const getServerSnapshot = () => false;

/**
 * True while <html> has the TV layout class (#951). False on the server and
 * during hydration, so the first client render matches the server's.
 */
export function useTvMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
