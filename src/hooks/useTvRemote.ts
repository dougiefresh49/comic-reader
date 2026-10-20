"use client";

import { useEffect, useRef, useState } from "react";
import { isTvBackKey, stepFocusIndex } from "~/lib/tv-mode";
import { focusableIn } from "~/hooks/useTvArrowFocus";

// The reader renders these attributes only in TV mode.
const BUBBLE = "[data-tv-bubble]";
type Bar = "top" | "bottom";

function bubbleButtons(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(BUBBLE)];
}

/** A bar's controls in DOM order; a bar root may itself be the control. */
function barControls(bar: Bar): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(`[data-tv-bar="${bar}"]`),
  ].flatMap((root) =>
    root.matches("a[href], button")
      ? root.matches(":disabled")
        ? []
        : [root]
      : focusableIn(root),
  );
}

function barOf(el: Element | null): Bar | null {
  const side = el?.closest<HTMLElement>("[data-tv-bar]")?.dataset.tvBar;
  return side === "top" || side === "bottom" ? side : null;
}

function focus(el: HTMLElement | undefined) {
  // The top bar slides off screen while hidden; focusing it must not scroll
  // the reader's overflow-hidden root.
  el?.focus({ preventScroll: true });
}

function isTextField(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  );
}

interface UseTvRemoteOptions {
  /** TV mode is on. Off, the hook adds no listener and moves no focus. */
  enabled: boolean;
  /**
   * False while a sheet, the onboarding overlay or the end-of-issue screen
   * owns the keyboard: arrows stand down, Back still works.
   */
  navEnabled: boolean;
  /** Changes on a panel turn; focus then goes to the first bubble. */
  focusKey: string;
  /** Back on the remote: closes the topmost layer, or leaves the reader. */
  onBack: () => void;
}

/**
 * The reader's remote control in TV mode (#951). Up and Down walk the
 * bubbles in render order (the order playback uses), and past either end
 * into the top or bottom bar. In a bar, Left and Right move between its
 * controls instead of turning the page, and Down/Up or Back return to the
 * bubble focus left from. Enter needs nothing here: a focused bubble is a
 * button, and Enter clicks it. Returns whether focus is on a bar control, so
 * the reader can hold the chrome up.
 */
export function useTvRemote({
  enabled,
  navEnabled,
  focusKey,
  onBack,
}: UseTvRemoteOptions) {
  const [barFocused, setBarFocused] = useState(false);
  const onBackRef = useRef(onBack);
  const navEnabledRef = useRef(navEnabled);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);
  useEffect(() => {
    navEnabledRef.current = navEnabled;
  }, [navEnabled]);

  useEffect(() => {
    if (!enabled) {
      setBarFocused(false);
      return;
    }
    // The bubble focus last left from, so a bar hands focus back to it.
    let lastBubble: HTMLElement | null = null;
    const sync = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches(BUBBLE)) {
        lastBubble = active;
      }
      setBarFocused(barOf(active) !== null);
    };
    const backToPage = (fallback: "first" | "last") => {
      const bubbles = bubbleButtons();
      focus(
        lastBubble && bubbles.includes(lastBubble)
          ? lastBubble
          : fallback === "first"
            ? bubbles[0]
            : bubbles[bubbles.length - 1],
      );
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTvBackKey(e)) {
        if (e.key === "Backspace" && isTextField(e.target)) return;
        e.preventDefault();
        // On a bar control, Back returns to the page first.
        const bar = navEnabledRef.current
          ? barOf(document.activeElement)
          : null;
        if (bar && bubbleButtons().length) {
          backToPage(bar === "top" ? "first" : "last");
          return;
        }
        onBackRef.current();
        return;
      }
      if (!navEnabledRef.current || e.defaultPrevented) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      sync();
      const active =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const bar = barOf(active);

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // Off a bar, the page and panel hooks turn the page.
        if (!bar || !active) return;
        e.preventDefault();
        // This listener runs in the capture phase, so stopping here keeps
        // the page and panel hooks' window listeners from seeing the key.
        e.stopPropagation();
        const items = barControls(bar);
        const next = stepFocusIndex(
          items.indexOf(active),
          items.length,
          e.key === "ArrowRight" ? 1 : -1,
        );
        if (next !== null) focus(items[next]);
        return;
      }

      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const down = e.key === "ArrowDown";
      const bubbles = bubbleButtons();
      if (bar) {
        // Away from the bubbles goes nowhere; toward them returns to the
        // bubble focus left from (else the nearest end), or crosses to the
        // other bar on a page with none.
        if ((bar === "top") !== down) return;
        if (bubbles.length) backToPage(down ? "first" : "last");
        else focus(barControls(down ? "bottom" : "top")[0]);
        return;
      }
      const next = stepFocusIndex(
        active ? bubbles.indexOf(active) : -1,
        bubbles.length,
        down ? 1 : -1,
      );
      focus(
        next !== null ? bubbles[next] : barControls(down ? "bottom" : "top")[0],
      );
    };

    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", sync);
    sync();
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", sync);
    };
  }, [enabled]);

  // On mount (a page turn remounts the reader), on a panel turn, and when a
  // layer closes: focus the first bubble, unless focus is already on a
  // bubble or a bar control.
  useEffect(() => {
    if (!enabled || !navEnabled) return;
    const active = document.activeElement;
    if (barOf(active) || active?.matches(BUBBLE)) return;
    focus(bubbleButtons()[0]);
  }, [enabled, navEnabled, focusKey]);

  return { barFocused };
}
