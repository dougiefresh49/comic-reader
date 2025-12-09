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
        <div className="flex items-center gap-3 px-4 py-3">
          {Array.from({ length: pageCount }, (_, i) => i + 1).map((page) => {
            const formatted = String(page).padStart(2, "0");
            const isActive = page === currentPage;
            return (
              <Link
                key={page}
                href={`/book/${bookId}/${issueId}/${page}`}
                className={`group relative flex h-28 w-20 shrink-0 flex-col overflow-hidden rounded-lg border transition-all ${isActive ? "border-cyan-400 shadow-[0_0_0_2px_rgba(34,211,238,0.35)]" : "border-neutral-800 hover:border-neutral-600"}`}
                onClick={onClose}
              >
                <Image
                  src={`/comics/${bookId}/${issueId}/pages/page-${formatted}.webp`}
                  alt={`Page ${page}`}
                  fill
                  sizes="96px"
                  className="object-cover"
                />
                <div className="pointer-events-none absolute right-0 bottom-0 left-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1 text-center text-xs font-semibold text-white">
                  {page}
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </BottomSheet>
  );
}

export default PageSelectorSheet;
