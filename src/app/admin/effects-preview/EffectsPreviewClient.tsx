"use client";

import { useEffect, useState } from "react";
import { getEffect } from "~/components/motion-comic/effects/registry";

const SAMPLE_BBOX = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
const SAMPLE_BG =
  "linear-gradient(135deg, #1a1a2e 0%, #16213e 30%, #0f3460 70%, #533483 100%)";

export function EffectsPreviewClient({ tags }: { tags: string[] }) {
  const [progress, setProgress] = useState(0);

  // Drive a 4-second progress loop so the user sees the full lifecycle.
  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const t = ((performance.now() - start) / 4000) % 1;
      setProgress(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tags.map((tag) => {
        const Effect = getEffect(tag);
        const implemented = Boolean(Effect);
        return (
          <div
            key={tag}
            className={`rounded-lg border ${implemented ? "border-cyan-700" : "border-neutral-800"} bg-neutral-900 p-3`}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-xs text-neutral-300">{tag}</span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] ${implemented ? "bg-cyan-800/50 text-cyan-200" : "bg-neutral-800 text-neutral-500"}`}
              >
                {implemented ? "v1" : "v2"}
              </span>
            </div>
            <div
              className="relative aspect-square overflow-hidden rounded"
              style={{ background: SAMPLE_BG }}
            >
              {Effect && (
                <Effect
                  bbox={SAMPLE_BBOX}
                  active
                  progress={progress}
                  reducedMotion={false}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
