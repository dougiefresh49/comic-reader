"use client";

import { useCallback, useEffect, useState } from "react";

const AUTOPLAY_KEY = "zen-reader-autoplay";
const VOLUMES_KEY = "zen-reader-volumes";
const PLAYBACK_RATE_KEY = "zen-reader-playback-rate";
const PANEL_VIEW_PREFERRED_KEY = "zen-reader-panel-view-preferred";
const MOTION_INTENSITY_KEY = "zen-reader-motion-intensity";
const MUTE_ALL_KEY = "zen-reader-mute-all";
const VOICES_ONLY_KEY = "zen-reader-voices-only";

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

  const [muteAll, setMuteAll] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(MUTE_ALL_KEY) === "true";
  });

  const [voicesOnly, setVoicesOnly] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(VOICES_ONLY_KEY) === "true";
  });

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
    window.localStorage.setItem(MUTE_ALL_KEY, String(muteAll));
  }, [muteAll]);

  useEffect(() => {
    window.localStorage.setItem(VOICES_ONLY_KEY, String(voicesOnly));
  }, [voicesOnly]);

  useEffect(() => {
    window.localStorage.setItem(
      PANEL_VIEW_PREFERRED_KEY,
      String(panelViewPreferred),
    );
  }, [panelViewPreferred]);

  const toggleAutoPlay = useCallback(() => {
    setAutoPlayEnabled((prev) => !prev);
  }, []);

  const toggleMuteAll = useCallback(() => {
    setMuteAll((prev) => !prev);
  }, []);

  const toggleVoicesOnly = useCallback(() => {
    setVoicesOnly((prev) => {
      if (!prev) setMuteAll(false);
      return !prev;
    });
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

  const effectiveVolumes: LayerVolumes = muteAll
    ? { dialogue: 0, ambience: 0, sfx: 0, music: 0 }
    : voicesOnly
      ? { dialogue: volumes.dialogue, ambience: 0, sfx: 0, music: 0 }
      : volumes;

  return {
    autoPlayEnabled,
    toggleAutoPlay,
    volumes,
    effectiveVolumes,
    setLayerVolume,
    resetVolumes,
    muteAll,
    toggleMuteAll,
    voicesOnly,
    toggleVoicesOnly,
    playbackRate,
    setPlaybackRate,
    panelViewPreferred,
    setPanelViewPreferred,
    motionIntensity,
    setMotionIntensity,
  };
}
