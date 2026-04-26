"use client";

import { useCallback, useEffect, useState } from "react";

const AUTOPLAY_KEY = "zen-reader-autoplay";

export function useSettings() {
  const [autoPlayEnabled, setAutoPlayEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(AUTOPLAY_KEY);
    return stored !== null ? stored === "true" : true;
  });

  useEffect(() => {
    window.localStorage.setItem(AUTOPLAY_KEY, String(autoPlayEnabled));
  }, [autoPlayEnabled]);

  const toggleAutoPlay = useCallback(() => {
    setAutoPlayEnabled((prev) => !prev);
  }, []);

  return { autoPlayEnabled, toggleAutoPlay };
}
