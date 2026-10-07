"use client";

import { useEffect, useRef } from "react";
import { audioLibraryUrl } from "~/lib/audio-library";
import type { PageDirectedPanel } from "~/types/panels";

interface Props {
  panel: PageDirectedPanel | null;
  /** True only in panel-view auto-play mode; otherwise everything is paused. */
  active: boolean;
  /** Mute the entire layer (settings toggle). Defaults false. */
  muted?: boolean;
  /** Optional per-layer volume overrides (0..1). */
  volume?: { ambience?: number; sfx?: number; music?: number };
  /** True when the panel transitions to a new scene — triggers music crossfade. */
  newScene?: boolean;
  /** Stable scene ID from music_scenes table — when set, overrides tag-based continuity. */
  sceneId?: string | null;
}

const DEFAULT_VOLUME = { ambience: 0.25, sfx: 0.5, music: 0.2 };
const FADE_MS = 800;

/**
 * Loudness goes through Web Audio, never `el.volume`: iOS WebKit ignores
 * writes to `HTMLMediaElement.volume` (it reads back 1), so a slider that
 * set it did nothing on an iPad (#609). Every browser takes this path.
 *
 * The graph lives at module level and outlives any effect cleanup: an
 * element connected to a MediaElementAudioSourceNode stays bound to it for
 * life, so a StrictMode double pass or remount must find the existing gain
 * rather than connect the element again (which throws). One context for the
 * app, created on first play, never closed; the WeakMap lets an unmounted
 * element and its nodes be collected.
 */
let sharedCtx: AudioContext | null = null;
const gains = new WeakMap<HTMLAudioElement, GainNode>();

/**
 * WebKit lets a context resume only inside a gesture's activation window,
 * so call this on the task that follows a tap or slider move, never from a
 * later timer. A rejection is swallowed; the next gesture tries again.
 */
function resumeIfSuspended() {
  if (sharedCtx?.state === "suspended") {
    void sharedCtx.resume().catch(() => undefined);
  }
}

/**
 * Routes `el` through its own GainNode on first use. The context is created
 * here, the first time a layer is about to play, never at render or mount,
 * and resumed at once: the music effect calls this on the tap's task, while
 * its first `play()` waits out the 800 ms crossfade.
 */
function ensureConnected(el: HTMLAudioElement, level: number): GainNode {
  sharedCtx ??= new AudioContext();
  resumeIfSuspended();
  const existing = gains.get(el);
  if (existing) return existing;
  const gain = sharedCtx.createGain();
  gain.gain.value = level;
  sharedCtx
    .createMediaElementSource(el)
    .connect(gain)
    .connect(sharedCtx.destination);
  gains.set(el, gain);
  return gain;
}

/** A layer at zero is also muted, which silences it even if the context cannot run. */
function applyLevel(el: HTMLAudioElement | null, level: number) {
  if (!el) return;
  resumeIfSuspended();
  el.muted = level === 0;
  const gain = gains.get(el);
  if (gain) gain.gain.value = level;
}

function playLayer(el: HTMLAudioElement, level: number) {
  ensureConnected(el, level);
  sharedCtx?.resume().catch(() => undefined);
  el.play().catch(() => undefined);
}

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
  sceneId = null,
}: Props) {
  const ambienceRef = useRef<HTMLAudioElement | null>(null);
  const sfxRef = useRef<HTMLAudioElement | null>(null);
  const musicRef = useRef<HTMLAudioElement | null>(null);
  const lastMusicTagRef = useRef<string | null>(null);
  const lastSceneIdRef = useRef<string | null>(null);
  // Effective per-layer levels, read by the play paths so a slider move
  // never re-triggers the one-shot sfx effect.
  const levelsRef = useRef({ ambience: 0, sfx: 0, music: 0 });

  // Build URLs from current panel tags. Empty arrays → null.
  const ambienceTag = panel?.audioTags.ambience[0] ?? null;
  const sfxTag = panel?.audioTags.sfx[0] ?? null;
  const musicTag = panel?.audioTags.music_mood ?? null;

  // ── Volumes ────────────────────────────────────────────────────────────
  useEffect(() => {
    const levels = {
      ambience: (volume.ambience ?? DEFAULT_VOLUME.ambience) * (muted ? 0 : 1),
      sfx: (volume.sfx ?? DEFAULT_VOLUME.sfx) * (muted ? 0 : 1),
      music: (volume.music ?? DEFAULT_VOLUME.music) * (muted ? 0 : 1),
    };
    levelsRef.current = levels;
    applyLevel(ambienceRef.current, levels.ambience);
    applyLevel(sfxRef.current, levels.sfx);
    applyLevel(musicRef.current, levels.music);
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
      playLayer(el, levelsRef.current.ambience);
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
    playLayer(el, levelsRef.current.sfx);
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

    const sameScene = sceneId != null && lastSceneIdRef.current === sceneId;
    const sameMood = lastMusicTagRef.current === musicTag;
    const continuePlaying = sameScene || (sameMood && !newScene);
    const url = audioLibraryUrl("music", musicTag);
    const gain = ensureConnected(el, targetVol);

    if (continuePlaying) {
      // A cleanup mid-fade-in leaves the gain partway up the ramp; land on
      // the target rather than staying quieter than the settings ask for.
      gain.gain.value = targetVol;
      if (el.paused) playLayer(el, targetVol);
      lastSceneIdRef.current = sceneId;
      lastMusicTagRef.current = musicTag;
      return;
    }

    // Crossfade: fade out current → swap → fade in
    const startVol = gain.gain.value;
    const fadeOutSteps = 16;
    const stepMs = FADE_MS / fadeOutSteps;
    let i = 0;
    let fadeIn: ReturnType<typeof setInterval> | undefined;
    const fadeOut = setInterval(() => {
      i++;
      gain.gain.value = Math.max(0, startVol * (1 - i / fadeOutSteps));
      if (i >= fadeOutSteps) {
        clearInterval(fadeOut);
        el.pause();
        el.src = url;
        el.load();
        gain.gain.value = 0;
        playLayer(el, 0);
        lastMusicTagRef.current = musicTag;
        lastSceneIdRef.current = sceneId;

        let j = 0;
        fadeIn = setInterval(() => {
          j++;
          gain.gain.value = Math.min(targetVol, targetVol * (j / fadeOutSteps));
          if (j >= fadeOutSteps) clearInterval(fadeIn);
        }, stepMs);
      }
    }, stepMs);
    return () => {
      clearInterval(fadeOut);
      clearInterval(fadeIn);
    };
  }, [musicTag, active, muted, newScene, sceneId, volume.music]);

  return (
    <>
      <audio ref={ambienceRef} crossOrigin="anonymous" loop preload="none" />
      <audio ref={sfxRef} crossOrigin="anonymous" preload="none" />
      <audio ref={musicRef} crossOrigin="anonymous" loop preload="none" />
    </>
  );
}
