"use client";

import { useEffect, useState } from "react";
import { getEffect } from "~/components/motion-comic/effects/registry";

const SAMPLE_BBOX = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
const SAMPLE_BG =
  "linear-gradient(135deg, #1a1a2e 0%, #16213e 30%, #0f3460 70%, #533483 100%)";

/**
 * Effects preview gallery.
 *
 * Only one effect runs at a time: tap a card to start it, tap another to
 * swap. This is a deliberate constraint — running 13+ tsParticles
 * canvases simultaneously was crashing mobile browsers.
 */
export function EffectsPreviewClient({ tags }: { tags: string[] }) {
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  // Drive `progress` only when something is active.
  useEffect(() => {
    if (!activeTag) {
      setProgress(0);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const t = ((performance.now() - start) / 4000) % 1;
      setProgress(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [activeTag]);

  return (
    <>
      <p className="mb-4 rounded border border-cyan-800/40 bg-cyan-900/10 px-3 py-2 text-xs text-cyan-200">
        Tap a card to play that effect. Only one runs at a time — tapping
        another swaps it. Tap the active one again to stop.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tags.map((tag) => {
          const Effect = getEffect(tag);
          const implemented = Boolean(Effect);
          const isActive = activeTag === tag;
          return (
            <button
              type="button"
              key={tag}
              onClick={() => {
                if (!implemented) return;
                setActiveTag((curr) => (curr === tag ? null : tag));
              }}
              disabled={!implemented}
              className={`rounded-lg border p-3 text-left transition-colors ${
                isActive
                  ? "border-cyan-400 bg-neutral-800"
                  : implemented
                    ? "border-cyan-700 bg-neutral-900 hover:border-cyan-500"
                    : "cursor-not-allowed border-neutral-800 bg-neutral-900 opacity-60"
              }`}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="font-mono text-xs text-neutral-300">
                  {tag}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    isActive
                      ? "bg-cyan-500 text-neutral-900"
                      : implemented
                        ? "bg-cyan-800/50 text-cyan-200"
                        : "bg-neutral-800 text-neutral-500"
                  }`}
                >
                  {isActive ? "● playing" : implemented ? "tap to play" : "v2"}
                </span>
              </div>
              <div
                className="relative aspect-square overflow-hidden rounded"
                style={{ background: SAMPLE_BG }}
              >
                {Effect && isActive && (
                  <Effect
                    bbox={SAMPLE_BBOX}
                    active
                    progress={progress}
                    reducedMotion={false}
                  />
                )}
                {!isActive && implemented && (
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-500">
                    ▶ tap
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}
