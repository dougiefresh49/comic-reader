"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  isTvBackKey,
  nearestInDirection,
  type TvDirection,
} from "~/lib/tv-mode";
import { focusableIn } from "~/hooks/useTvArrowFocus";

const DIRECTIONS: Record<string, TvDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** Every card control on the page: the links and buttons in the TV grids. */
function cardControls(): HTMLElement[] {
  return [...document.querySelectorAll("[data-tv-grid]")].flatMap((grid) =>
    focusableIn(grid),
  );
}

/**
 * The list pages' remote control in TV mode (#951): arrows move focus to the
 * nearest card control on screen in that direction, the first arrow press
 * with nothing focused lands on the first one, and Enter opens a card as a
 * link does. Back goes to `backHref`; with none (the library) it does
 * nothing. Off TV mode the hook adds no listener.
 */
export function useTvGridFocus(enabled: boolean, backHref: string | null) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      const inTextField =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (isTvBackKey(e)) {
        if (e.key === "Backspace" && inTextField) return;
        // Cancelled on the library too, so the TV does nothing there.
        e.preventDefault();
        if (backHref) router.push(backHref);
        return;
      }
      const dir = DIRECTIONS[e.key];
      if (!dir || e.shiftKey || inTextField) return;
      const cards = cardControls();
      const active = document.activeElement;
      const onCard = active instanceof HTMLElement && cards.includes(active);
      const next = !onCard
        ? 0
        : nearestInDirection(
            active.getBoundingClientRect(),
            cards.map((c) => c.getBoundingClientRect()),
            dir,
          );
      // No card that way: the arrow scrolls the page as it always did.
      if (next === null || !cards[next]) return;
      e.preventDefault();
      // Centered, so the focused card never sits in the TV's overscan.
      cards[next].focus({ preventScroll: true });
      cards[next].scrollIntoView({ block: "center", inline: "nearest" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, backHref, router]);
}
