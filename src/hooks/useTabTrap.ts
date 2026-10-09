"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

/**
 * Keeps Tab inside `ref`'s box while it is mounted: Tab and Shift-Tab step
 * through its tabbable elements and wrap at the ends, and from outside the
 * box they land on the first or the last. The list is read at each keypress,
 * so a button that `busy` disables drops out of it.
 */
export function useTabTrap(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const box = ref.current;
      if (e.key !== "Tab" || e.defaultPrevented || !box) return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) =>
          el.tabIndex >= 0 &&
          !el.matches(":disabled") &&
          el.getClientRects().length > 0,
      );
      // Every step is ours, not only the wrap: Safari's default Tab skips
      // buttons, so leaving the middle steps to the browser lets focus out.
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const step = e.shiftKey ? -1 : 1;
      const from = i === -1 ? (e.shiftKey ? 0 : -1) : i;
      items[(from + step + items.length) % items.length]?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ref]);
}
