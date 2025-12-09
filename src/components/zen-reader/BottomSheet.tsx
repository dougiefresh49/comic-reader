"use client";

import { useEffect } from "react";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  height?: string;
}

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  height = "320px",
}: BottomSheetProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) {
      window.addEventListener("keydown", onKey);
    }
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity duration-200"
        onClick={onClose}
      />
      <div className="fixed inset-x-0 bottom-0 z-50 animate-[slide-up_220ms_ease-out]">
        <div
          className="mx-auto max-w-5xl rounded-t-2xl border border-neutral-800 bg-neutral-950/95 shadow-2xl backdrop-blur"
          style={{ height }}
        >
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm font-medium tracking-wide text-neutral-200 uppercase">
              {title}
            </span>
            <button
              onClick={onClose}
              className="rounded-full p-2 text-neutral-400 hover:bg-white/10 hover:text-white"
              aria-label="Close sheet"
            >
              ✕
            </button>
          </div>
          <div className="h-[1px] w-full bg-neutral-800" />
          <div className="h-[calc(100%-56px)] overflow-hidden">{children}</div>
        </div>
      </div>
      <style jsx global>{`
        @keyframes slide-up {
          from {
            transform: translateY(100%);
          }
          to {
            transform: translateY(0);
          }
        }
      `}</style>
    </>
  );
}

export default BottomSheet;
