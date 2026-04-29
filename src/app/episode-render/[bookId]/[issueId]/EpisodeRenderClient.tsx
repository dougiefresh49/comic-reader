"use client";

import { useEffect, useRef, useState } from "react";
import {
  PanelDimOverlay,
  PanelViewFrame,
} from "~/components/zen-comic-reader/PanelView";
import { PanelEffectsOverlay } from "~/components/motion-comic/effects/PanelEffectsOverlay";
import { PanelAudioLayer } from "~/components/motion-comic/PanelAudioLayer";
import type { PageDirectedPanel } from "~/types/panels";

interface Props {
  bookId: string;
  issueId: string;
  panels: PageDirectedPanel[];
  pageImages: Record<number, string>;
}

/**
 * Render-only reader. Auto-plays through every panel with deterministic
 * timing. When all panels finish, sets `window.__episodeRenderDone =
 * true` so the Playwright capture script knows when to stop recording.
 *
 * Each panel is held for `estimatedDurationSeconds || 4s`. We don't
 * wait on real audio playback because the export-episode-mp4 script
 * mixes the audio in via ffmpeg from the source files, not from
 * Chromium's output. The render is purely a video stream.
 */
const DEFAULT_PANEL_DURATION_S = 4;

export function EpisodeRenderClient({ panels, pageImages }: Props) {
  const [panelIndex, setPanelIndex] = useState(0);
  const finishedRef = useRef(false);
  const activePanel = panels[panelIndex];
  const currentPage = activePanel?.pageNumber ?? 1;
  const pageImage = pageImages[currentPage] ?? "";

  // Derive a flat "panels" list scoped to the current page so
  // PanelViewFrame can compute the right zoom transform.
  const panelsOnPage = panels.filter((p) => p.pageNumber === currentPage);
  const localIndex = activePanel
    ? panelsOnPage.findIndex((p) => p.id === activePanel.id)
    : 0;

  useEffect(() => {
    if (panelIndex >= panels.length) {
      if (!finishedRef.current) {
        finishedRef.current = true;
        (
          window as unknown as { __episodeRenderDone?: boolean }
        ).__episodeRenderDone = true;
      }
      return;
    }
    const dur =
      activePanel?.estimatedDurationSeconds ?? DEFAULT_PANEL_DURATION_S;
    const t = setTimeout(() => setPanelIndex((i) => i + 1), dur * 1000);
    return () => clearTimeout(t);
  }, [panelIndex, panels.length, activePanel]);

  if (!activePanel) {
    return (
      <div className="flex min-h-screen items-center justify-center text-white">
        Episode complete
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-0 flex flex-col items-center justify-center bg-black">
      <div className="relative h-full w-full max-w-[min(100vw,calc(100vh*0.667))]">
        <PanelViewFrame
          panelViewMode={true}
          panels={panelsOnPage}
          panelIndex={localIndex >= 0 ? localIndex : 0}
          reducedMotion={false}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={pageImage}
            alt=""
            className="absolute inset-0 h-full w-full object-contain"
          />
          <PanelDimOverlay bbox={activePanel.boundingBox} />
          <PanelEffectsOverlay
            panel={activePanel}
            active
            reducedMotion={false}
            durationMs={
              (activePanel.estimatedDurationSeconds ??
                DEFAULT_PANEL_DURATION_S) * 1000
            }
          />
          <PanelAudioLayer
            panel={activePanel}
            active
            muted={false}
            newScene={activePanel.isNewScene}
          />
        </PanelViewFrame>
      </div>
    </div>
  );
}
