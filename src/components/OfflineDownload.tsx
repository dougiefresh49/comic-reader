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
        className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
          done
            ? "bg-emerald-700 text-white"
            : busy
              ? "bg-cyan-700/60 text-white"
              : "bg-cyan-700 text-white hover:bg-cyan-600 disabled:opacity-40"
        }`}
        aria-label={
          label ? `Download ${label} for offline reading` : "Download offline"
        }
      >
        {done
          ? "✓ Available offline"
          : busy
            ? `Downloading… ${pct}%`
            : "Download for offline"}
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
