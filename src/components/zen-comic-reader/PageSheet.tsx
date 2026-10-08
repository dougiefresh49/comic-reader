"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { pageImageUrl } from "~/lib/storage";
import { pageLabel, spreadPagesFor } from "~/lib/spreads";
import { SheetShell } from "~/components/ui/SheetShell";

interface PageSheetProps {
  bookId: string;
  issueId: string;
  pageCount: number;
  currentPage: number;
  /** Left pages of the issue's spreads (#724); each spread is one wide thumbnail. */
  spreadStarts?: number[];
  isOpen: boolean;
  onClose: () => void;
}

export function PageSheet({
  bookId,
  issueId,
  pageCount,
  currentPage,
  spreadStarts = [],
  isOpen,
  onClose,
}: PageSheetProps) {
  const activeThumbRef = useRef<HTMLAnchorElement | null>(null);
  // The reader mounts under /book and /admin/preview; thumbnails stay on
  // whichever route opened it (an unpublished book 404s under /book).
  const basePath = usePathname().startsWith("/admin/preview/")
    ? "/admin/preview"
    : "/book";

  useEffect(() => {
    if (!isOpen) return;
    activeThumbRef.current?.scrollIntoView({
      inline: "center",
      block: "nearest",
    });
  }, [isOpen]);

  // One entry per stop: a single page, or a spread's two pages as one.
  const stops = Array.from({ length: pageCount }, (_, i) => i + 1).flatMap(
    (page) => {
      const spread = spreadPagesFor(page, spreadStarts);
      if (!spread) return [{ page, pages: [page] }];
      return spread.left === page
        ? [{ page, pages: [spread.left, spread.right] }]
        : [];
    },
  );
  const currentLabel = pageLabel(currentPage, spreadStarts);

  return (
    <SheetShell
      isOpen={isOpen}
      onClose={onClose}
      title="Pages"
      titleExtra={
        <span className="text-xs text-neutral-400 tabular-nums">
          {currentLabel.includes("–") ? "Pages" : "Page"} {currentLabel} of{" "}
          {pageCount}
        </span>
      }
      closeLabel="Close page selector"
      panelClassName="max-w-4xl pb-4"
    >
      <div className="flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-1 py-3">
        {stops.map(({ page, pages }) => {
          const href = `${basePath}/${bookId}/${issueId}/${page}`;
          const isActive = pages.includes(currentPage);
          const label = pages.join("–");

          return (
            <Link
              key={page}
              href={href}
              ref={isActive ? activeThumbRef : null}
              className={`group relative flex h-44 shrink-0 snap-start overflow-hidden rounded-2xl border transition-transform sm:h-52 ${
                pages.length > 1 ? "w-64 sm:w-72" : "w-32 sm:w-36"
              } ${
                isActive
                  ? "border-cyan-500/70 ring-2 ring-cyan-400/60"
                  : "border-white/10 opacity-80 hover:border-white/30 hover:opacity-100"
              }`}
              onClick={onClose}
            >
              {pages.length === 1 ? (
                <Image
                  src={pageImageUrl(bookId, issueId, page)}
                  alt={`Page ${page}`}
                  fill
                  sizes="(min-width: 640px) 144px, 128px"
                  className="object-cover"
                  loading="lazy"
                />
              ) : (
                pages.map((n, i) => (
                  <div
                    key={n}
                    className={`absolute inset-y-0 w-32 sm:w-36 ${
                      i === 0 ? "left-0" : "right-0"
                    }`}
                  >
                    <Image
                      src={pageImageUrl(bookId, issueId, n)}
                      alt={`Page ${n}`}
                      fill
                      sizes="(min-width: 640px) 144px, 128px"
                      className="object-cover"
                      loading="lazy"
                    />
                  </div>
                ))
              )}
              <div className="absolute bottom-2 left-2 rounded-full bg-black/70 px-2 py-1 text-xs font-semibold text-white">
                {label}
              </div>
            </Link>
          );
        })}
      </div>
    </SheetShell>
  );
}
