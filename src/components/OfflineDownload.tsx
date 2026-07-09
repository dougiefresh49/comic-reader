"use client";

import { useCallback, useEffect, useState } from "react";
import { useServiceWorker } from "~/hooks/useServiceWorker";

interface Props {
  /** All URLs the issue needs to read offline (pages + bubble audio). */
  urls: string[];
  /** Display label, e.g. "Issue 1: Foo Bar". */
  label?: string;
}

interface Progress {
  done: number;
  total: number;
  failed: number;
  complete: boolean;
}

/**
 * Triggers the service worker to prefetch every URL needed for an
 * issue. Shows a progress bar; clicking again after completion is a
 * no-op since SW will already have everything cached.
 *
 * Usage on the book page or issue card. Renders nothing if service
 * workers aren't supported (Safari incognito, old browsers).
 */
export function OfflineDownload({ urls, label }: Props) {
  const { ready, registration } = useServiceWorker();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  // Mounted is only true after the first client effect runs. Skipping
  // the render until then keeps server and client output identical
  // and avoids hydration mismatches caused by Node 21+'s stub
  // `navigator` object.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const start = useCallback(async () => {
    if (!ready) return;
    const sw = registration?.active ?? navigator.serviceWorker.controller;
    if (!sw) return;
    setBusy(true);
    setProgress({ done: 0, total: urls.length, failed: 0, complete: false });
    const channel = new MessageChannel();
    channel.port1.onmessage = (e: MessageEvent<Progress>) => {
      setProgress(e.data);
      if (e.data.complete) {
        setBusy(false);
        channel.port1.close();
      }
    };
    sw.postMessage({ type: "PREFETCH", urls }, [channel.port2]);
  }, [ready, registration, urls]);

  if (!mounted) return null;
  if (!("serviceWorker" in navigator)) return null;

  const pct = progress
    ? Math.round((progress.done / Math.max(1, progress.total)) * 100)
    : 0;
  const done = progress?.complete ?? false;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={!ready || busy}
        onClick={start}
        className={`inline-flex items-center justify-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-medium transition-colors ${
          done
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            : busy
              ? "border-white/15 bg-white/5 text-neutral-400"
              : "border-white/15 bg-white/5 text-neutral-300 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:outline-none disabled:opacity-40"
        }`}
        aria-label={
          label ? `Download ${label} for offline reading` : "Download offline"
        }
      >
        {done ? (
          <>
            <IconCheck />
            Available offline
          </>
        ) : busy ? (
          <span className="tabular-nums">Downloading… {pct}%</span>
        ) : (
          <>
            <IconDownload />
            Download offline
          </>
        )}
      </button>
      {progress && !progress.complete && (
        <div className="h-1 w-full overflow-hidden rounded bg-neutral-800">
          <div
            className="h-full bg-cyan-500 transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {progress?.complete && progress.failed > 0 && (
        <span className="text-[10px] text-amber-400">
          {progress.failed} file(s) failed — partial offline only
        </span>
      )}
    </div>
  );
}

const svgProps = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function IconDownload() {
  return (
    <svg {...svgProps}>
      <path d="M12 15V3" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg {...svgProps}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
