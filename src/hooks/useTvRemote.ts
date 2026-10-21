"use client";

import { useEffect, useRef, useState } from "react";
import { isTvBackKey, stepFocusIndex, tvMediaKey } from "~/lib/tv-mode";
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

/** Where focus enters the bottom bar: its play/pause, else its first control. */
function bottomEntry(): HTMLElement | undefined {
  const items = barControls("bottom");
  return items.find((el) => el.matches("[data-tv-play]")) ?? items[0];
}

function barOf(el: Element | null): Bar | null {
  const side = el?.closest<HTMLElement>("[data-tv-bar]")?.dataset.tvBar;
  return side === "top" || side === "bottom" ? side : null;
}

/**
 * Panel view's container (#964): the focusable ancestor of the frame
 * PanelViewFrame marks in TV panel mode. With focus there, Left and Right
 * reach the panel hooks. None outside panel view.
 */
function panelContainer(): HTMLElement | undefined {
  return (
    document
      .querySelector("[data-tv-panel-frame]")
      ?.closest<HTMLElement>('[tabindex="0"]') ?? undefined
  );
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
  /** The page or panel is being read: a clip sounds, or auto-play waits. */
  reading: boolean;
  /** Something is held, so Enter right after an Enter pause resumes it. */
  resumable: boolean;
  /** What the bottom bar's play/pause control does in the current view. */
  onPlayPause: () => void;
}

/**
 * The reader's remote control in TV mode (#951). Up and Down walk the
 * bubbles in render order (the order playback uses), and past either end
 * into the top or bottom bar; the bottom bar is entered on its play/pause.
 * In a bar, Left and Right move between its controls instead of turning the
 * page, and Down/Up or Back return to the bubble focus left from. On a panel
 * with no bubbles, Down/Up from a bar go to the panel container instead
 * (#964): Left and Right there turn panels, and Up/Down move on to the bars.
 * Off a bar, Enter clicks the focused bubble.
 *
 * While the page is being read the remote works like a video player's
 * (#991): Up or Down off a bar wakes the controls, with focus on play/pause,
 * and Enter off a bar pauses. The next Enter resumes, until focus moves or
 * an arrow is pressed. The Play/Pause media keys do what play/pause does.
 * Returns whether focus is on a bar control, so the reader can hold the
 * chrome up.
 */
export function useTvRemote({
  enabled,
  navEnabled,
  focusKey,
  onBack,
  reading,
  resumable,
  onPlayPause,
}: UseTvRemoteOptions) {
  const [barFocused, setBarFocused] = useState(false);
  const onBackRef = useRef(onBack);
  const navEnabledRef = useRef(navEnabled);
  const readingRef = useRef(reading);
  const onPlayPauseRef = useRef(onPlayPause);
  const resumableRef = useRef(resumable);
  const restoreFocusRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);
  useEffect(() => {
    navEnabledRef.current = navEnabled;
  }, [navEnabled]);
  useEffect(() => {
    readingRef.current = reading;
    resumableRef.current = resumable;
  }, [reading, resumable]);
  useEffect(() => {
    onPlayPauseRef.current = onPlayPause;
  }, [onPlayPause]);

  useEffect(() => {
    if (!enabled) {
      setBarFocused(false);
      return;
    }
    // The bubble focus last left from, so a bar hands focus back to it.
    let lastBubble: HTMLElement | null = null;
    // Where focus was at an Enter pause, so the next Enter there resumes.
    let enterPausedAt: Element | null = null;
    const sync = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches(BUBBLE)) {
        lastBubble = active;
      }
      if (active !== enterPausedAt) enterPausedAt = null;
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
        // On the top bar, Back returns to the page first. From the bottom
        // bar it acts at once, so one Back leaves panel view from its HUD.
        const onTopBar =
          navEnabledRef.current && barOf(document.activeElement) === "top";
        if (onTopBar && bubbleButtons().length) {
          backToPage("first");
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

      const media = tvMediaKey(e);
      if (media) {
        e.preventDefault();
        const isReading = readingRef.current;
        if (
          media === "playPause" ||
          (media === "play" && !isReading) ||
          (media === "pause" && isReading)
        ) {
          onPlayPauseRef.current();
        }
        return;
      }

      if (e.key === "Enter") {
        // On a bar control, Enter presses it.
        if (bar) return;
        const pausing = readingRef.current;
        const resuming =
          !pausing &&
          resumableRef.current &&
          enterPausedAt !== null &&
          enterPausedAt === document.activeElement;
        if (!pausing && !resuming) return;
        // No click on the focused bubble: Enter is play/pause here.
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        enterPausedAt = pausing ? document.activeElement : null;
        onPlayPauseRef.current();
        return;
      }

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        enterPausedAt = null;
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
      enterPausedAt = null;
      const down = e.key === "ArrowDown";
      if (!bar && readingRef.current) {
        // Being read, the arrows wake the controls: one press to play/pause.
        focus(bottomEntry());
        return;
      }
      const bubbles = bubbleButtons();
      if (bar) {
        // Away from the bubbles goes nowhere; toward them returns to the
        // bubble focus left from (else the nearest end). With none, it goes
        // to the panel container in panel view, else to the other bar.
        if ((bar === "top") !== down) return;
        if (bubbles.length) backToPage(down ? "first" : "last");
        else
          focus(
            panelContainer() ?? (down ? bottomEntry() : barControls("top")[0]),
          );
        return;
      }
      const next = stepFocusIndex(
        active ? bubbles.indexOf(active) : -1,
        bubbles.length,
        down ? 1 : -1,
      );
      focus(
        next !== null
          ? bubbles[next]
          : down
            ? bottomEntry()
            : barControls("top")[0],
      );
    };

    // A pause can unmount the control focus was on (the caption's Pause when
    // only playback shows it): focus goes back to the bubble left from, and
    // an Enter pause made there still resumes.
    restoreFocusRef.current = () => {
      const lost = enterPausedAt?.isConnected === false;
      backToPage("first");
      if (lost) enterPausedAt = document.activeElement;
      sync();
    };

    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", sync);
    sync();
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", sync);
    };
  }, [enabled]);

  useEffect(() => {
    const active = document.activeElement;
    if (!enabled || !navEnabledRef.current || reading) return;
    if (!active || active === document.body) restoreFocusRef.current();
  }, [enabled, reading]);

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
