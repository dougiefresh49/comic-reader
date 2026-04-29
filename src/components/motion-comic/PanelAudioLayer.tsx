"use client";

import { useEffect, useRef } from "react";
import { audioLibraryUrl } from "~/lib/audio-library";
import type { PageDirectedPanel } from "~/types/panels";

interface Props {
  panel: PageDirectedPanel | null;
  /** True only in panel-view auto-play mode; otherwise everything is paused. */
  active: boolean;
  /** Mute the entire layer (settings toggle). Defaults true since the audio library may be empty. */
  muted?: boolean;
  /** Optional per-layer volume overrides (0..1). */
  volume?: { ambience?: number; sfx?: number; music?: number };
  /** True when the panel transitions to a new scene — triggers music crossfade. */
  newScene?: boolean;
}

const DEFAULT_VOLUME = { ambience: 0.25, sfx: 0.5, music: 0.2 };
const FADE_MS = 800;

/**
 * Three-track audio mix for a single panel. Mounts inside <PanelViewFrame>
 * as a sibling to <PanelEffectsOverlay>. No <audio> tags are visible —
 * this component just side-effects three refs.
 *
 * Audio sources resolve to library URLs by tag (see src/lib/audio-library.ts).
 * If a tag has no cached file in the bucket the corresponding <audio> errors
 * silently and that layer plays nothing — no crash, no console spam.
 */
export function PanelAudioLayer({
  panel,
  active,
  muted = false,
  volume = DEFAULT_VOLUME,
  newScene = false,
}: Props) {
  const ambienceRef = useRef<HTMLAudioElement | null>(null);
  const sfxRef = useRef<HTMLAudioElement | null>(null);
  const musicRef = useRef<HTMLAudioElement | null>(null);
  const lastMusicTagRef = useRef<string | null>(null);

  // Build URLs from current panel tags. Empty arrays → null.
  const ambienceTag = panel?.audioTags.ambience[0] ?? null;
  const sfxTag = panel?.audioTags.sfx[0] ?? null;
  const musicTag = panel?.audioTags.music_mood ?? null;

  // ── Volumes ────────────────────────────────────────────────────────────
  useEffect(() => {
    const ambVol =
      (volume.ambience ?? DEFAULT_VOLUME.ambience) * (muted ? 0 : 1);
    const sfxVol = (volume.sfx ?? DEFAULT_VOLUME.sfx) * (muted ? 0 : 1);
    const musVol = (volume.music ?? DEFAULT_VOLUME.music) * (muted ? 0 : 1);
    if (ambienceRef.current) ambienceRef.current.volume = ambVol;
    if (sfxRef.current) sfxRef.current.volume = sfxVol;
    if (musicRef.current) musicRef.current.volume = musVol;
  }, [muted, volume]);

  // ── Ambience: swap source on tag change, loop, play when active ────────
  useEffect(() => {
    const el = ambienceRef.current;
    if (!el) return;
    const url = ambienceTag ? audioLibraryUrl("ambience", ambienceTag) : "";
    if (el.src !== url) {
      el.src = url;
      el.load();
    }
    if (active && url && !muted) {
      el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }, [ambienceTag, active, muted]);

  // ── SFX: one-shot on panel entry ───────────────────────────────────────
  useEffect(() => {
    const el = sfxRef.current;
    if (!el || !active || !sfxTag || muted) return;
    el.src = audioLibraryUrl("sfx", sfxTag);
    el.currentTime = 0;
    el.play().catch(() => undefined);
  }, [sfxTag, active, muted, panel?.id]);

  // ── Music: crossfade on new scene; otherwise continue current bed ──────
  useEffect(() => {
    const el = musicRef.current;
    if (!el) return;
    const targetVol = (volume.music ?? DEFAULT_VOLUME.music) * (muted ? 0 : 1);

    if (!active || !musicTag) {
      el.pause();
      return;
    }

    const same = lastMusicTagRef.current === musicTag;
    const url = audioLibraryUrl("music", musicTag);

    if (same && !newScene) {
      // Continue playing the current bed
      if (el.paused) el.play().catch(() => undefined);
      return;
    }

    // Crossfade: fade out current → swap → fade in
    const startVol = el.volume;
    const fadeOutSteps = 16;
    const stepMs = FADE_MS / fadeOutSteps;
    let i = 0;
    const fadeOut = setInterval(() => {
      i++;
      el.volume = Math.max(0, startVol * (1 - i / fadeOutSteps));
      if (i >= fadeOutSteps) {
        clearInterval(fadeOut);
        el.pause();
        el.src = url;
        el.load();
        el.volume = 0;
        el.play().catch(() => undefined);
        lastMusicTagRef.current = musicTag;

        let j = 0;
        const fadeIn = setInterval(() => {
          j++;
          el.volume = Math.min(targetVol, targetVol * (j / fadeOutSteps));
          if (j >= fadeOutSteps) clearInterval(fadeIn);
        }, stepMs);
      }
    }, stepMs);
    return () => {
      clearInterval(fadeOut);
    };
  }, [musicTag, active, muted, newScene, volume.music]);

  return (
    <>
      <audio ref={ambienceRef} loop preload="none" />
      <audio ref={sfxRef} preload="none" />
      <audio ref={musicRef} loop preload="none" />
    </>
  );
}
