"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { pageImageUrl } from "~/lib/storage";
import { SheetShell } from "~/components/ui/SheetShell";

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
  const activeThumbRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    activeThumbRef.current?.scrollIntoView({
      inline: "center",
      block: "nearest",
    });
  }, [isOpen]);

  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);

  return (
    <SheetShell
      isOpen={isOpen}
      onClose={onClose}
      title="Pages"
      titleExtra={
        <span className="text-xs text-neutral-400 tabular-nums">
          Page {currentPage} of {pageCount}
        </span>
      }
      closeLabel="Close page selector"
      panelClassName="max-w-4xl pb-4"
    >
      <div className="flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-1 py-3">
        {pages.map((page) => {
          const href = `/book/${bookId}/${issueId}/${page}`;
          const isActive = page === currentPage;

          return (
            <Link
              key={page}
              href={href}
              ref={isActive ? activeThumbRef : null}
              className={`group relative flex h-44 w-32 shrink-0 snap-start overflow-hidden rounded-2xl border transition-transform sm:h-52 sm:w-36 ${
                isActive
                  ? "border-cyan-500/70 ring-2 ring-cyan-400/60"
                  : "border-white/10 opacity-80 hover:border-white/30 hover:opacity-100"
              }`}
              onClick={onClose}
            >
              <Image
                src={pageImageUrl(bookId, issueId, page)}
                alt={`Page ${page}`}
                fill
                sizes="(min-width: 640px) 144px, 128px"
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
    </SheetShell>
  );
}
