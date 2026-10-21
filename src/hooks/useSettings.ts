"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

const AUTOPLAY_KEY = "zen-reader-autoplay";
const VOLUMES_KEY = "zen-reader-volumes";
const PREMUTE_VOLUMES_KEY = "zen-reader-premute-volumes";
const PLAYBACK_RATE_KEY = "zen-reader-playback-rate";
const PANEL_VIEW_PREFERRED_KEY = "zen-reader-panel-view-preferred";
const MOTION_INTENSITY_KEY = "zen-reader-motion-intensity";
const MUTE_ALL_KEY = "zen-reader-mute-all";
const VOICES_ONLY_KEY = "zen-reader-voices-only";
const AUTO_ADVANCE_PAGE_KEY = "zen-reader-auto-advance-page";
const WORD_HIGHLIGHT_KEY = "zen-reader-word-highlight";
const CAPTION_BAR_KEY = "zen-reader-caption-bar";

export type MotionIntensity = "off" | "reduced" | "full";

/**
 * Where the spoken word lights up (#87): on the bubble's lettering, in the
 * caption bar, or both. A bubble without word boxes always uses the caption.
 */
export type WordHighlightMode = "bubble" | "caption" | "both";

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

function readWordHighlightMode(): WordHighlightMode {
  if (typeof window === "undefined") return "bubble";
  const stored = window.localStorage.getItem(WORD_HIGHLIGHT_KEY);
  if (stored === "bubble" || stored === "caption" || stored === "both")
    return stored;
  return "bubble";
}

const subscribeToNothing = () => () => undefined;

/** The caption bar follows the highlight mode until the user sets it apart (#607). */
function captionBarFor(mode: WordHighlightMode): boolean {
  return mode !== "bubble";
}

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

/**
 * Each layer's level from before its mute button was pressed (#989), so
 * Unmute puts it back. Only the mute button writes an entry; any other
 * change to the layer clears it.
 */
type PreMuteVolumes = Partial<LayerVolumes>;

function readPreMuteVolumes(): PreMuteVolumes {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(PREMUTE_VOLUMES_KEY);
    if (stored == null) return {};
    return JSON.parse(stored) as PreMuteVolumes;
  } catch {
    return {};
  }
}

function withoutLayer(
  prev: PreMuteVolumes,
  layer: keyof LayerVolumes,
): PreMuteVolumes {
  if (!(layer in prev)) return prev;
  const next = { ...prev };
  delete next[layer];
  return next;
}

export function useSettings() {
  const [autoPlayEnabled, setAutoPlayEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(AUTOPLAY_KEY);
    return stored !== null ? stored === "true" : true;
  });

  const [volumes, setVolumes] = useState<LayerVolumes>(readVolumes);
  const [preMuteVolumes, setPreMuteVolumes] =
    useState<PreMuteVolumes>(readPreMuteVolumes);

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

  const [autoAdvancePage, setAutoAdvancePage] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(AUTO_ADVANCE_PAGE_KEY);
    return stored !== null ? stored === "true" : true;
  });

  const [wordHighlightMode, setWordHighlightModeState] =
    useState<WordHighlightMode>(readWordHighlightMode);

  // Nothing stored: derive from the highlight mode, so "In bubble" (the default)
  // starts with the bar off and a stored "Both" or caption mode starts with it on.
  const [storedCaptionBar, setCaptionBar] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(CAPTION_BAR_KEY);
    if (stored === "true" || stored === "false") return stored === "true";
    return captionBarFor(readWordHighlightMode());
  });
  // Unlike the other settings, the bar changes the reader's markup, so the
  // server's render (bar on) must hydrate as is. The stored value takes over
  // on the first client render; page turns never hydrate, so only a hard
  // load with the bar off shows it for one frame.
  const hydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  const captionBar = hydrated ? storedCaptionBar : true;

  const [muteAll, setMuteAll] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(MUTE_ALL_KEY) === "true";
  });

  const [voicesOnly, setVoicesOnly] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(VOICES_ONLY_KEY);
    return stored !== null ? stored === "true" : true;
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
    window.localStorage.setItem(
      PREMUTE_VOLUMES_KEY,
      JSON.stringify(preMuteVolumes),
    );
  }, [preMuteVolumes]);

  useEffect(() => {
    window.localStorage.setItem(PLAYBACK_RATE_KEY, String(playbackRate));
  }, [playbackRate]);

  useEffect(() => {
    window.localStorage.setItem(MOTION_INTENSITY_KEY, motionIntensity);
  }, [motionIntensity]);

  useEffect(() => {
    window.localStorage.setItem(AUTO_ADVANCE_PAGE_KEY, String(autoAdvancePage));
  }, [autoAdvancePage]);

  useEffect(() => {
    window.localStorage.setItem(WORD_HIGHLIGHT_KEY, wordHighlightMode);
  }, [wordHighlightMode]);

  useEffect(() => {
    window.localStorage.setItem(CAPTION_BAR_KEY, String(storedCaptionBar));
  }, [storedCaptionBar]);

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

  // Choosing a highlight mode also sets the bar; the bar's own toggle then
  // stands on its own until the next mode change.
  const setWordHighlightMode = useCallback((mode: WordHighlightMode) => {
    setWordHighlightModeState(mode);
    setCaptionBar(captionBarFor(mode));
  }, []);

  const toggleAutoPlay = useCallback(() => {
    setAutoPlayEnabled((prev) => !prev);
  }, []);

  const toggleAutoAdvancePage = useCallback(() => {
    setAutoAdvancePage((prev) => !prev);
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
      setPreMuteVolumes((prev) => withoutLayer(prev, layer));
    },
    [],
  );

  // Mute remembers the layer's level; Unmute restores it, or the layer's
  // default when nothing is remembered (e.g. the slider was dragged to 0).
  const toggleLayerMute = useCallback(
    (layer: keyof LayerVolumes) => {
      const current = volumes[layer];
      if (current === 0) {
        const restored = preMuteVolumes[layer];
        setVolumes((prev) => ({
          ...prev,
          [layer]:
            typeof restored === "number" && restored > 0 && restored <= 1
              ? restored
              : DEFAULT_VOLUMES[layer],
        }));
        setPreMuteVolumes((prev) => withoutLayer(prev, layer));
      } else {
        setPreMuteVolumes((prev) => ({ ...prev, [layer]: current }));
        setVolumes((prev) => ({ ...prev, [layer]: 0 }));
      }
    },
    [volumes, preMuteVolumes],
  );

  const resetVolumes = useCallback(() => {
    setVolumes(DEFAULT_VOLUMES);
    setPreMuteVolumes({});
  }, []);

  const effectiveVolumes: LayerVolumes = muteAll
    ? { dialogue: 0, ambience: 0, sfx: 0, music: 0 }
    : voicesOnly
      ? { dialogue: volumes.dialogue, ambience: 0, sfx: 0, music: 0 }
      : volumes;

  return {
    autoPlayEnabled,
    toggleAutoPlay,
    autoAdvancePage,
    toggleAutoAdvancePage,
    volumes,
    effectiveVolumes,
    setLayerVolume,
    toggleLayerMute,
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
    wordHighlightMode,
    setWordHighlightMode,
    captionBar,
    setCaptionBar,
  };
}
