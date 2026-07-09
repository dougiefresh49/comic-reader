"use client";

interface SheetShellProps {
  isOpen: boolean;
  onClose: () => void;
  /** Uppercase tracked header label, e.g. "Pages" / "Settings". */
  title: string;
  /** Optional extra header content rendered beside the title (e.g. "Page 3 of 26"). */
  titleExtra?: React.ReactNode;
  /** aria-label for the close button. */
  closeLabel: string;
  /** Sizing/scroll overrides for the sheet panel (max-w, max-h, pb, overflow). */
  panelClassName?: string;
  children: React.ReactNode;
}

/**
 * Shared bottom-sheet chrome: dimmed backdrop, rounded glass panel, tracked
 * uppercase title, and an icon close button. Design canon lives here so
 * PageSheet/SettingsSheet stay in lockstep.
 */
export function SheetShell({
  isOpen,
  onClose,
  title,
  titleExtra,
  closeLabel,
  panelClassName = "",
  children,
}: SheetShellProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`w-full rounded-t-3xl border border-white/10 bg-neutral-950/95 px-4 pt-3 shadow-[0_-10px_40px_rgba(0,0,0,0.45)] ${panelClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between px-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-[0.08em] text-neutral-200 uppercase">
              {title}
            </span>
            {titleExtra}
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
            aria-label={closeLabel}
          >
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
              <line x1="18" x2="6" y1="6" y2="18" />
              <line x1="6" x2="18" y1="6" y2="18" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
