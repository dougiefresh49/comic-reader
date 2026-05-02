"use client";

import { useCallback, useEffect, useState } from "react";

const AUTOPLAY_KEY = "zen-reader-autoplay";
const VOLUMES_KEY = "zen-reader-volumes";
const PLAYBACK_RATE_KEY = "zen-reader-playback-rate";
const PANEL_VIEW_PREFERRED_KEY = "zen-reader-panel-view-preferred";
const MOTION_INTENSITY_KEY = "zen-reader-motion-intensity";

export type MotionIntensity = "off" | "reduced" | "full";

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

  const [panelViewPreferred, setPanelViewPreferred] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem(PANEL_VIEW_PREFERRED_KEY);
    return stored === "true";
  });

  const [motionIntensity, setMotionIntensity] = useState<MotionIntensity>(
    () => {
      if (typeof window === "undefined") return "full";
      const stored = window.localStorage.getItem(MOTION_INTENSITY_KEY);
      if (stored === "off" || stored === "reduced" || stored === "full")
        return stored;
      return "full";
    },
  );

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

  useEffect(() => {
    window.localStorage.setItem(MOTION_INTENSITY_KEY, motionIntensity);
  }, [motionIntensity]);

  useEffect(() => {
    window.localStorage.setItem(
      PANEL_VIEW_PREFERRED_KEY,
      String(panelViewPreferred),
    );
  }, [panelViewPreferred]);

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
    panelViewPreferred,
    setPanelViewPreferred,
    motionIntensity,
    setMotionIntensity,
  };
}
