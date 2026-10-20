"use client";

import { useTvMode } from "~/hooks/useTvMode";
import { useTvGridFocus } from "~/hooks/useTvGridFocus";

/**
 * A list page's card grid. Renders the same div the page did, plus the
 * `data-tv-grid` marker in TV mode (#951), which the remote's focus and the
 * TV layout rules in globals.css read.
 */
export function TvGrid({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  const tv = useTvMode();
  return (
    <div className={className} data-tv-grid={tv ? "" : undefined}>
      {children}
    </div>
  );
}

/**
 * Mount once per list page: the remote's arrows, Enter and Back in TV mode
 * (#951). `backHref` is where the page's own back link goes; the library
 * passes null, and Back there does nothing.
 */
export function TvListNav({ backHref }: { backHref: string | null }) {
  useTvGridFocus(useTvMode(), backHref);
  return null;
}
