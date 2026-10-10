"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useDrag } from "@use-gesture/react";
import { useTabTrap } from "~/hooks/useTabTrap";

/** Where a reader can go from the last page of an issue (#830). */
export interface EndOfIssue {
  /** The book's next issue that has pages, or null. */
  nextIssue: { href: string; label: string } | null;
  /** Only when there is no next issue: the next book in the series. */
  nextBook: { href: string; label: string } | null;
  libraryHref: "/";
}

const SWIPE_MIN_DISTANCE = 60;

interface EndOfIssueScreenProps {
  endOfIssue: EndOfIssue;
  bookName: string;
  issueNumber: number;
  /** Back to the last page, left as it was. */
  onBack: () => void;
}

/**
 * Shown after a forward turn from an issue's last page. It owns focus and
 * the keyboard while open, as the onboarding overlay does: Tab stays inside,
 * Escape or ArrowLeft goes back, and a swipe right goes back too.
 */
export function EndOfIssueScreen({
  endOfIssue,
  bookName,
  issueNumber,
  onBack,
}: EndOfIssueScreenProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useTabTrap(rootRef);

  // Focus lands on the first choice, the biggest button. React's `autoFocus`
  // only covers form controls, and these are links.
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>("a[href]")?.focus();
  }, []);

  // Opacity starts at 0 and flips on the next frame, so the screen fades in.
  // `motion-reduce:transition-none` makes that flip instant.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === "Escape" || e.key === "ArrowLeft") {
        e.preventDefault();
        onBack();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  const bindDrag = useDrag(
    ({ last, movement: [mx], canceled }) => {
      if (last && !canceled && mx > SWIPE_MIN_DISTANCE) onBack();
    },
    { axis: "x", filterTaps: true, threshold: 12 },
  );

  const { nextIssue, nextBook, libraryHref } = endOfIssue;
  const primary = nextIssue
    ? { title: "Next issue", ...nextIssue }
    : nextBook
      ? { title: "Next book", ...nextBook }
      : null;

  return (
    <div
      ref={rootRef}
      {...bindDrag()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="end-of-issue-title"
      className={`fixed inset-0 z-[60] flex touch-pan-y flex-col items-center justify-center overflow-y-auto bg-neutral-950 px-6 py-10 transition-opacity duration-200 motion-reduce:transition-none ${
        shown ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="flex w-full max-w-sm flex-col items-center">
        <h2
          id="end-of-issue-title"
          className="text-4xl font-semibold text-white"
        >
          The End
        </h2>
        <p className="mt-2 text-center text-sm text-neutral-400">
          {bookName} · Issue {issueNumber}
        </p>

        <div className="mt-10 flex w-full flex-col gap-3">
          {primary ? (
            <Link
              href={primary.href}
              className="flex min-h-16 w-full flex-col items-center justify-center rounded-xl bg-cyan-500 px-4 py-2 text-neutral-950 transition-colors hover:bg-cyan-400"
            >
              <span className="text-lg font-semibold">{primary.title}</span>
              <span className="max-w-full truncate text-sm text-neutral-800">
                {primary.label}
              </span>
            </Link>
          ) : null}
          <Link
            href={libraryHref}
            className={`flex w-full items-center justify-center rounded-xl font-semibold transition-colors ${
              primary
                ? "h-12 border border-white/10 bg-white/5 text-base text-neutral-200 hover:bg-white/10"
                : "min-h-16 bg-cyan-500 text-lg text-neutral-950 hover:bg-cyan-400"
            }`}
          >
            Library
          </Link>
          <button
            type="button"
            onClick={onBack}
            className="flex h-12 w-full items-center justify-center gap-1.5 rounded-xl text-sm font-semibold text-neutral-400 transition-colors hover:bg-white/5 hover:text-neutral-200"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
