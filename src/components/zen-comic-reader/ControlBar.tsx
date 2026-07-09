"use client";

interface ControlBarProps {
  children: React.ReactNode;
  pageNumber: number;
  pageCount: number;
  /** Panel mode shows its own cyan panel-progress bar — keep ONE progress story. */
  hidePageProgress?: boolean;
}

export function ControlBar({
  children,
  pageNumber,
  pageCount,
  hidePageProgress = false,
}: ControlBarProps) {
  const progress = pageCount > 0 ? pageNumber / pageCount : 0;

  return (
    <div className="z-50 flex shrink-0 flex-col border-t border-white/5 bg-neutral-950/95 backdrop-blur">
      <div className="flex min-h-[72px] items-center px-4 py-2">{children}</div>
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
