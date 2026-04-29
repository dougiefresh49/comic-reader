"use client";

import { useEffect, useState } from "react";

interface ServiceWorkerState {
  registration: ServiceWorkerRegistration | null;
  ready: boolean;
}

/**
 * Registers /sw.js once on first mount and keeps a reference to the
 * registration. Used by the offline-download button to send PREFETCH
 * messages.
 */
export function useServiceWorker(): ServiceWorkerState {
  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    let cancelled = false;
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(async (reg) => {
        if (cancelled) return;
        setRegistration(reg);
        await navigator.serviceWorker.ready;
        if (cancelled) return;
        setReady(true);
      })
      .catch((err) => {
        console.warn("Service worker registration failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { registration, ready };
}
