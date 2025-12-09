"use client";

interface SettingsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  autoPlayEnabled: boolean;
  onToggleAutoPlay: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  hasNext: boolean;
  hasPrev: boolean;
}

export function SettingsSheet({
  isOpen,
  onClose,
  autoPlayEnabled,
  onToggleAutoPlay,
  onNext,
  onPrev,
  hasNext,
  hasPrev,
}: SettingsSheetProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-t-3xl border border-white/10 bg-neutral-950/95 px-4 pt-3 pb-5 shadow-[0_-10px_40px_rgba(0,0,0,0.45)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between px-1">
          <span className="text-sm font-semibold tracking-[0.08em] text-neutral-200 uppercase">
            Settings
          </span>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Close settings"
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

        <div className="flex flex-col gap-3">
          <button
            onClick={onToggleAutoPlay}
            className={`flex items-center justify-between rounded-2xl border px-4 py-3 text-left transition-colors ${
              autoPlayEnabled
                ? "border-cyan-500/60 bg-cyan-500/10 text-white"
                : "border-white/10 bg-white/5 text-neutral-100"
            }`}
          >
            <div className="flex items-center gap-3">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={
                  autoPlayEnabled ? "text-cyan-400" : "text-neutral-300"
                }
              >
                <polyline points="1 4 1 10 7 10" />
                <polyline points="23 20 23 14 17 14" />
                <path d="M20.49 9A9 9 0 0 0 6.21 6.21L1 10" />
                <path d="M3.51 15A9 9 0 0 0 17.79 17.79L23 14" />
              </svg>
              <div>
                <div className="text-sm font-semibold">Auto Play</div>
                <div className="text-xs text-neutral-400">
                  Toggle continuous reading
                </div>
              </div>
            </div>
            <div
              className={`h-5 w-10 rounded-full p-0.5 transition-colors ${
                autoPlayEnabled ? "bg-cyan-500" : "bg-neutral-700"
              }`}
            >
              <div
                className={`h-4 w-4 rounded-full bg-white transition-transform ${
                  autoPlayEnabled ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </div>
          </button>

          <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
            <div className="text-sm font-semibold text-neutral-100">
              Page Controls
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onPrev}
                disabled={!hasPrev}
                className={`rounded-full p-3 transition-colors ${
                  hasPrev
                    ? "bg-neutral-800 text-white hover:bg-neutral-700"
                    : "cursor-not-allowed bg-neutral-900 text-neutral-600"
                }`}
                aria-label="Previous page"
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
                >
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>

              <button
                onClick={onNext}
                disabled={!hasNext}
                className={`rounded-full p-3 transition-colors ${
                  hasNext
                    ? "bg-neutral-800 text-white hover:bg-neutral-700"
                    : "cursor-not-allowed bg-neutral-900 text-neutral-600"
                }`}
                aria-label="Next page"
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
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
