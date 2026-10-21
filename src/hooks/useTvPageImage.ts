"use client";

import { useEffect, useState } from "react";
import { useTvMode } from "~/hooks/useTvMode";
import { peekTvPageImageUrl, retainTvPageImage } from "~/lib/tv-page-image";

/**
 * The page image URL to render (#962). Off TV mode it is `src`, unchanged.
 * In TV mode it is the downscaled copy once made, and null until then: the
 * caller renders no image while it is null, so the TV never decodes the
 * full-size page. The copy stays pinned while this is mounted, so its URL
 * is never revoked under the image.
 */
export function useTvPageImage(src: string): string | null {
  const tvMode = useTvMode();
  const [made, setMade] = useState<{ src: string; url: string } | null>(null);

  useEffect(() => {
    if (!tvMode) return;
    let live = true;
    const { promise, release } = retainTvPageImage(src);
    void promise.then(({ url }) => {
      if (live) setMade({ src, url });
    });
    return () => {
      live = false;
      release();
    };
  }, [tvMode, src]);

  if (!tvMode) return src;
  if (made?.src === src) return made.url;
  // Panel view remounts the page art on every move; a made copy shows at
  // once instead of blinking out for a render.
  return peekTvPageImageUrl(src);
}
