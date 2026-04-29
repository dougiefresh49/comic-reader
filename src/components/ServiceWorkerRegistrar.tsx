"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js once at the root layout. Without this, the service
 * worker only mounts when an OfflineDownload component renders — which
 * means cached content wouldn't intercept on cold loads. Registering
 * at root means the SW is always active for any page.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  }, []);
  return null;
}
