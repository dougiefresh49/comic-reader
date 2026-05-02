"use client";

interface ViewSheetProps {
  isOpen: boolean;
  onClose: () => void;
  panelViewMode: boolean;
  onTogglePanelView: () => void;
  hasPanels: boolean;
}

export function ViewSheet({
  isOpen,
  onClose,
  panelViewMode,
  onTogglePanelView,
  hasPanels,
}: ViewSheetProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-end bg-black/40 pt-16 pr-3 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-56 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950/95 shadow-[0_10px_40px_rgba(0,0,0,0.45)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-white/5 px-4 py-3">
          <span className="text-xs font-semibold tracking-[0.08em] text-neutral-400 uppercase">
            View
          </span>
        </div>

        <div className="flex flex-col gap-1 p-2">
          <button
            type="button"
            onClick={() => {
              if (panelViewMode) onTogglePanelView();
              onClose();
            }}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
              !panelViewMode
                ? "bg-cyan-500/15 text-cyan-300"
                : "text-neutral-300 hover:bg-white/5"
            }`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" />
            </svg>
            Whole page
          </button>

          <button
            type="button"
            disabled={!hasPanels}
            onClick={() => {
              if (!panelViewMode) onTogglePanelView();
              onClose();
            }}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
              !hasPanels
                ? "cursor-not-allowed text-neutral-600"
                : panelViewMode
                  ? "bg-cyan-500/15 text-cyan-300"
                  : "text-neutral-300 hover:bg-white/5"
            }`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="7" height="9" x="3" y="3" rx="1" />
              <rect width="7" height="5" x="14" y="3" rx="1" />
              <rect width="7" height="9" x="14" y="12" rx="1" />
              <rect width="7" height="5" x="3" y="16" rx="1" />
            </svg>
            Panel by panel
          </button>
        </div>
      </div>
    </div>
  );
}
