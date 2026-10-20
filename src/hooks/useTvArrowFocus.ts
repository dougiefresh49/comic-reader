"use client";

import { useEffect, type RefObject } from "react";
import { stepFocusIndex } from "~/lib/tv-mode";

const FOCUSABLE = "a[href], button, input, select, textarea";

function isFocusable(el: Element): el is HTMLElement {
  return (
    el instanceof HTMLElement &&
    el.tabIndex >= 0 &&
    !el.matches(":disabled") &&
    el.getClientRects().length > 0
  );
}

/** The enabled, rendered controls inside `root`, in DOM order. */
export function focusableIn(root: Element): HTMLElement[] {
  return [...root.querySelectorAll(FOCUSABLE)].filter(isFocusable);
}

/**
 * The buttons or links beside `el` on one row under one parent: a
 * segmented control, a row of presets, the page thumbnails. Null for a
 * control that stands alone.
 */
function rowGroup(el: HTMLElement): HTMLElement[] | null {
  if (!el.matches("button, a[href]") || !el.parentElement) return null;
  const members = [...el.parentElement.children].filter(
    (c): c is HTMLElement => c.matches("button, a[href]") && isFocusable(c),
  );
  if (members.length < 2) return null;
  const top = el.getBoundingClientRect().top;
  return members.every((m) => Math.abs(m.getBoundingClientRect().top - top) < 4)
    ? members
    : null;
}

/** One Up/Down stop per control, a row group counting once. */
function stops(box: HTMLElement): HTMLElement[][] {
  const out: HTMLElement[][] = [];
  for (const el of focusableIn(box)) {
    const group = rowGroup(el);
    if (group && out.some((s) => s.includes(el))) continue;
    out.push(group ?? [el]);
  }
  return out;
}

/** Where focus lands in a stop: its pressed member, else its first. */
function landing(stop: HTMLElement[]): HTMLElement | undefined {
  return (
    stop.find(
      (m) =>
        m.getAttribute("aria-pressed") === "true" ||
        m.hasAttribute("data-tv-selected") ||
        // The Pages sheet: the thumbnail of the page being read.
        (m instanceof HTMLAnchorElement &&
          m.pathname === window.location.pathname),
    ) ?? stop[0]
  );
}

/** The first control of `box`, skipping `skip` (a sheet's close button). */
export function firstStop(
  box: HTMLElement,
  skip?: HTMLElement | null,
): HTMLElement | undefined {
  const first = stops(box).find((s) => !(skip && s.includes(skip)));
  return first ? landing(first) : undefined;
}

/**
 * TV mode only (#951): while `active`, the remote works the controls inside
 * `ref`. Up and Down step through them in on-screen order, a row of choices
 * counting as one stop, and stop at the ends. Left and Right move along a
 * row of choices (pressing each button, so the value changes as a slider's
 * would); a slider keeps its own Left/Right; anywhere else they do nothing
 * here, so a screen's own Left handling still runs.
 */
export function useTvArrowFocus(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const box = ref.current;
      if (!box) return;
      const current =
        document.activeElement instanceof HTMLElement &&
        box.contains(document.activeElement)
          ? document.activeElement
          : null;

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const group = current ? rowGroup(current) : null;
        if (!current || !group) return;
        e.preventDefault();
        const next = stepFocusIndex(
          group.indexOf(current),
          group.length,
          e.key === "ArrowRight" ? 1 : -1,
        );
        const target = next === null ? undefined : group[next];
        if (!target) return;
        target.focus();
        if (target.tagName === "BUTTON") target.click();
        return;
      }

      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const list = stops(box);
      const next = stepFocusIndex(
        current ? list.findIndex((s) => s.includes(current)) : -1,
        list.length,
        e.key === "ArrowDown" ? 1 : -1,
      );
      const stop = next === null ? undefined : list[next];
      if (stop) landing(stop)?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ref, active]);
}
