"use client";

interface EdgePageNavProps {
  side: "left" | "right";
  onNavigate: () => void;
  disabled: boolean;
}

/**
 * Desktop-only full-height edge strip for page turning. Barely visible at
 * rest; the chevron and gradient fade in on hover (or keyboard focus).
 * Rendered as a sibling of the gesture container — never inside it — so it
 * can't interfere with pinch/swipe/double-tap handling, and it disappears
 * entirely (pointer-events included) on first/last pages.
 */
export function EdgePageNav({ side, onNavigate, disabled }: EdgePageNavProps) {
  const isLeft = side === "left";
  return (
    <button
      type="button"
      onClick={onNavigate}
      disabled={disabled}
      aria-label={isLeft ? "Previous page" : "Next page"}
      className={`group absolute inset-y-0 z-30 hidden w-16 items-center lg:w-20 ${
        isLeft ? "left-0 justify-start pl-2" : "right-0 justify-end pr-2"
      } disabled:pointer-events-none disabled:opacity-0 md:flex`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100 ${
          isLeft
            ? "bg-gradient-to-r from-black/40 to-transparent"
            : "bg-gradient-to-l from-black/40 to-transparent"
        }`}
      />
      <span className="relative flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-neutral-950/80 text-neutral-200 opacity-0 backdrop-blur transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {isLeft ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
        </svg>
      </span>
    </button>
  );
}
