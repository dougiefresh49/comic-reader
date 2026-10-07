"use client";

import Link from "next/link";

interface TopBarProps {
  visible: boolean;
  onOpenPages: () => void;
  onOpenSettings: () => void;
  /** Whole page or panel by panel; the toggle sits beside the Pages button (#607). */
  panelViewMode: boolean;
  hasPanels: boolean;
  onTogglePanelView: () => void;
}

export function TopBar({
  visible,
  onOpenPages,
  onOpenSettings,
  panelViewMode,
  hasPanels,
  onTogglePanelView,
}: TopBarProps) {
  return (
    <div
      className={`absolute top-0 right-0 left-0 z-50 flex h-14 items-center justify-between border-b border-white/5 bg-neutral-950/90 px-3 backdrop-blur transition-transform duration-300 ${
        visible ? "translate-y-0" : "-translate-y-full"
      }`}
    >
      <div className="flex items-center gap-1">
        <Link
          href="/"
          className="rounded-full p-2 text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Library"
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
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Link>

        <button
          onClick={onOpenPages}
          className="rounded-full p-2 text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Pages"
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
            <rect width="7" height="7" x="3" y="3" rx="1" />
            <rect width="7" height="7" x="14" y="3" rx="1" />
            <rect width="7" height="7" x="14" y="14" rx="1" />
            <rect width="7" height="7" x="3" y="14" rx="1" />
          </svg>
        </button>

        <button
          type="button"
          onClick={onTogglePanelView}
          disabled={!hasPanels}
          aria-disabled={!hasPanels}
          aria-pressed={panelViewMode}
          aria-label="Panel by panel"
          title="Panel by panel"
          className={`rounded-full p-2 transition-colors ${
            !hasPanels
              ? "cursor-not-allowed text-neutral-600"
              : panelViewMode
                ? "bg-cyan-600 text-white hover:bg-cyan-500"
                : "text-neutral-300 hover:bg-white/10 hover:text-white"
          }`}
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
            <rect x="3" y="3" width="8" height="8" rx="1" />
            <rect x="14" y="3" width="7" height="8" rx="1" />
            <rect x="3" y="14" width="18" height="7" rx="1" />
          </svg>
        </button>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={onOpenSettings}
          className="rounded-full p-2 text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Settings"
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
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 3.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8 3.6 1.65 1.65 0 0 0 9.51 2.1H9.6a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 3.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.29.63.95 1 1.66 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
