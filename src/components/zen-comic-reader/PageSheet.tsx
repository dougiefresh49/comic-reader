"use client";

import Image from "next/image";
import Link from "next/link";

interface PageSheetProps {
  bookId: string;
  issueId: string;
  pageCount: number;
  currentPage: number;
  isOpen: boolean;
  onClose: () => void;
}

export function PageSheet({
  bookId,
  issueId,
  pageCount,
  currentPage,
  isOpen,
  onClose,
}: PageSheetProps) {
  if (!isOpen) return null;

  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl rounded-t-3xl border border-white/10 bg-neutral-950/95 px-4 pt-3 pb-4 shadow-[0_-10px_40px_rgba(0,0,0,0.45)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between px-1">
          <span className="text-sm font-semibold tracking-[0.08em] text-neutral-200 uppercase">
            Pages ({pageCount})
          </span>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Close page selector"
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

        <div className="flex gap-3 overflow-x-auto pt-1 pb-2">
          {pages.map((page) => {
            const padded = String(page).padStart(2, "0");
            const href = `/book/${bookId}/${issueId}/${page}`;
            const isActive = page === currentPage;

            return (
              <Link
                key={page}
                href={href}
                className={`group relative flex h-44 w-32 shrink-0 snap-start overflow-hidden rounded-2xl border transition-transform ${
                  isActive
                    ? "border-cyan-500/70 ring-2 ring-cyan-400/60"
                    : "border-white/10 hover:border-white/30"
                }`}
                onClick={onClose}
              >
                <Image
                  src={`/comics/${bookId}/${issueId}/pages/page-${padded}.webp`}
                  alt={`Page ${page}`}
                  fill
                  sizes="128px"
                  className="object-cover"
                  loading="lazy"
                />
                <div className="absolute bottom-2 left-2 rounded-full bg-black/70 px-2 py-1 text-xs font-semibold text-white">
                  {page}
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
