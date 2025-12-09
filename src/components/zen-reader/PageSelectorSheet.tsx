"use client";

import Image from "next/image";
import Link from "next/link";
import BottomSheet from "./BottomSheet";

interface PageSelectorSheetProps {
  open: boolean;
  onClose: () => void;
  currentPage: number;
  pageCount: number;
  bookId: string;
  issueId: string;
}

export function PageSelectorSheet({
  open,
  onClose,
  currentPage,
  pageCount,
  bookId,
  issueId,
}: PageSelectorSheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Pages" height="260px">
      <div className="h-full overflow-x-auto">
        <div className="flex items-start gap-3 px-4 py-3">
          {Array.from({ length: pageCount }, (_, i) => i + 1).map((page) => {
            const formatted = String(page).padStart(2, "0");
            const isActive = page === currentPage;
            return (
              <div
                key={page}
                className="flex shrink-0 flex-col items-center gap-2"
              >
                <Link
                  href={`/book/${bookId}/${issueId}/${page}`}
                  className={`group relative flex h-28 w-20 flex-col overflow-hidden rounded-lg border-2 transition-all ${
                    isActive
                      ? "border-cyan-400 bg-cyan-400/10 shadow-[0_0_12px_rgba(34,211,238,0.5)] ring-2 ring-cyan-400/30"
                      : "border-neutral-800 hover:border-neutral-600"
                  }`}
                  onClick={onClose}
                >
                  <Image
                    src={`/comics/${bookId}/${issueId}/pages/page-${formatted}.webp`}
                    alt={`Page ${page}`}
                    fill
                    sizes="80px"
                    className="object-cover"
                  />
                </Link>
                <span
                  className={`text-xs font-semibold ${
                    isActive ? "text-cyan-300" : "text-neutral-400"
                  }`}
                >
                  {page}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </BottomSheet>
  );
}

export default PageSelectorSheet;
