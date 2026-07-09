"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";

interface UsePageNavigationOptions {
  prevPageLink?: string | null;
  nextPageLink?: string | null;
  /**
   * When true, ArrowLeft/ArrowRight turn the page (desktop affordance).
   * Keep false while panel-focus mode, sheets, or overlays own the keyboard.
   */
  keyboardEnabled?: boolean;
}

export function usePageNavigation({
  prevPageLink,
  nextPageLink,
  keyboardEnabled = false,
}: UsePageNavigationOptions) {
  const router = useRouter();

  const navigatePrev = useCallback(() => {
    if (prevPageLink) router.push(prevPageLink);
  }, [prevPageLink, router]);

  const navigateNext = useCallback(() => {
    if (nextPageLink) router.push(nextPageLink);
  }, [nextPageLink, router]);

  useEffect(() => {
    if (!keyboardEnabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        navigateNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        navigatePrev();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keyboardEnabled, navigateNext, navigatePrev]);

  return { navigatePrev, navigateNext };
}
