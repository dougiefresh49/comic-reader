"use client";

import Link from "next/link";
import BottomSheet from "./BottomSheet";

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  autoPlayEnabled: boolean;
  onToggleAutoPlay: () => void;
  prevPageLink?: string | null;
  nextPageLink?: string | null;
}

export function SettingsSheet({
  open,
  onClose,
  autoPlayEnabled,
  onToggleAutoPlay,
  prevPageLink,
  nextPageLink,
}: SettingsSheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Settings" height="220px">
      <div className="flex h-full flex-col gap-3 px-4 py-4">
        <div className="flex items-center gap-3">
          <button
            onClick={onToggleAutoPlay}
            className={`flex items-center gap-2 rounded-full px-3 py-2 text-sm font-semibold transition-colors ${autoPlayEnabled ? "bg-cyan-600 text-white shadow-[0_0_12px_rgba(34,211,238,0.35)]" : "bg-neutral-800 text-neutral-200 hover:bg-neutral-700"}`}
            aria-pressed={autoPlayEnabled}
          >
            <span className="text-lg">⟳</span>
            Auto Play
          </button>
          <span className="text-xs text-neutral-400">
            Toggle continuous bubble playback
          </span>
        </div>

        <div className="flex items-center gap-3">
          {prevPageLink ? (
            <Link
              href={prevPageLink}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-neutral-800 px-3 py-2 text-sm font-semibold text-white transition hover:bg-neutral-700"
              onClick={onClose}
            >
              ← Prev
            </Link>
          ) : (
            <button
              disabled
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-neutral-900 px-3 py-2 text-sm font-semibold text-neutral-600"
            >
              ← Prev
            </button>
          )}

          {nextPageLink ? (
            <Link
              href={nextPageLink}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-neutral-800 px-3 py-2 text-sm font-semibold text-white transition hover:bg-neutral-700"
              onClick={onClose}
            >
              Next →
            </Link>
          ) : (
            <button
              disabled
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-neutral-900 px-3 py-2 text-sm font-semibold text-neutral-600"
            >
              Next →
            </button>
          )}
        </div>

        <div className="rounded-lg border border-dashed border-neutral-800 px-3 py-2 text-xs text-neutral-400">
          Future: playback speed, voice selection, accessibility options.
        </div>
      </div>
    </BottomSheet>
  );
}

export default SettingsSheet;
