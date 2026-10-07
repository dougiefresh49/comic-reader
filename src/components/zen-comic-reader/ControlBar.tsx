"use client";

interface ControlBarProps {
  /** The row above the progress strip. Omit it and the row takes no height. */
  children?: React.ReactNode;
  pageNumber: number;
  pageCount: number;
  /** Panel mode shows its own cyan panel-progress bar — keep ONE progress story. */
  hidePageProgress?: boolean;
  /**
   * Panel view draws the bar over the page and slides it away with the top
   * bar (#607). Page view leaves it in the flex column, always shown.
   */
  overlay?: boolean;
  /** Only read when `overlay` is set; the bar stays mounted while hidden. */
  visible?: boolean;
  /** Skip the slide when the reader's motion setting is off. */
  reducedMotion?: boolean;
  /** Keyboard focus inside a hidden overlay bar brings the chrome back. */
  onFocusCapture?: () => void;
}

export function ControlBar({
  children,
  pageNumber,
  pageCount,
  hidePageProgress = false,
  overlay = false,
  visible = true,
  reducedMotion = false,
  onFocusCapture,
}: ControlBarProps) {
  const progress = pageCount > 0 ? pageNumber / pageCount : 0;
  const placement = overlay
    ? `absolute inset-x-0 bottom-0 ${
        reducedMotion ? "transition-none" : "transition-transform duration-300"
      } ${visible ? "translate-y-0" : "translate-y-full"}`
    : "shrink-0";

  return (
    <div
      className={`z-50 flex flex-col border-t border-white/5 bg-neutral-950/95 backdrop-blur ${placement}`}
      onFocusCapture={onFocusCapture}
    >
      {children != null && (
        <div className="flex min-h-[72px] items-center px-4 py-2">
          {children}
        </div>
      )}
      {!hidePageProgress && (
        <div className="relative h-1 w-full bg-white/5">
          <div
            className="h-full bg-cyan-500/60 transition-[width] duration-300 ease-out"
            style={{ width: `${progress * 100}%` }}
          />
          <span className="absolute -top-5 right-2 text-[10px] text-neutral-500 tabular-nums">
            {pageNumber}/{pageCount}
          </span>
        </div>
      )}
    </div>
  );
}
