"use client";

import { useCallback, useEffect, useState } from "react";

const AUTOPLAY_KEY = "zen-reader-autoplay";
const VOLUMES_KEY = "zen-reader-volumes";
const PLAYBACK_RATE_KEY = "zen-reader-playback-rate";

export interface LayerVolumes {
  dialogue: number;
  ambience: number;
  sfx: number;
  music: number;
}

const DEFAULT_VOLUMES: LayerVolumes = {
  dialogue: 1.0,
  ambience: 0.25,
  sfx: 0.5,
  music: 0.2,
};

const DEFAULT_PLAYBACK_RATE = 1.0;
export const PLAYBACK_RATE_MIN = 0.75;
export const PLAYBACK_RATE_MAX = 2.0;

function readVolumes(): LayerVolumes {
  if (typeof window === "undefined") return DEFAULT_VOLUMES;
  try {
    const stored = window.localStorage.getItem(VOLUMES_KEY);
    if (stored == null) return DEFAULT_VOLUMES;
    return {
      ...DEFAULT_VOLUMES,
      ...(JSON.parse(stored) as Partial<LayerVolumes>),
    };
  } catch {
    return DEFAULT_VOLUMES;
  }
}

export function useSettings() {
  const [autoPlayEnabled, setAutoPlayEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(AUTOPLAY_KEY);
    return stored !== null ? stored === "true" : true;
  });

  const [volumes, setVolumes] = useState<LayerVolumes>(readVolumes);

  const [playbackRate, setPlaybackRate] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_PLAYBACK_RATE;
    const stored = window.localStorage.getItem(PLAYBACK_RATE_KEY);
    if (stored == null) return DEFAULT_PLAYBACK_RATE;
    const parsed = parseFloat(stored);
    return Number.isFinite(parsed) ? parsed : DEFAULT_PLAYBACK_RATE;
  });

  useEffect(() => {
    window.localStorage.setItem(AUTOPLAY_KEY, String(autoPlayEnabled));
  }, [autoPlayEnabled]);

  useEffect(() => {
    window.localStorage.setItem(VOLUMES_KEY, JSON.stringify(volumes));
  }, [volumes]);

  useEffect(() => {
    window.localStorage.setItem(PLAYBACK_RATE_KEY, String(playbackRate));
  }, [playbackRate]);

  const toggleAutoPlay = useCallback(() => {
    setAutoPlayEnabled((prev) => !prev);
  }, []);

  const setLayerVolume = useCallback(
    (layer: keyof LayerVolumes, value: number) => {
      setVolumes((prev) => ({
        ...prev,
        [layer]: Math.max(0, Math.min(1, value)),
      }));
    },
    [],
  );

  const resetVolumes = useCallback(() => setVolumes(DEFAULT_VOLUMES), []);

  return {
    autoPlayEnabled,
    toggleAutoPlay,
    volumes,
    setLayerVolume,
    resetVolumes,
    playbackRate,
    setPlaybackRate,
  };
}
