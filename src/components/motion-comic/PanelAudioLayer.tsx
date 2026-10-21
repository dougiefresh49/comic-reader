"use client";

import { useEffect, useRef, useState } from "react";
import { audioLibraryUrl } from "~/lib/audio-library";
import {
  applyLevel,
  disconnect,
  ensureConnected,
  resumeContext,
} from "~/lib/audio-graph";
import { createMusicCarry } from "~/lib/music-carry";
import type { PageDirectedPanel } from "~/types/panels";

export interface Props {
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
const FADE_STEPS = 16;

function playLayer(el: HTMLAudioElement, level: number) {
  ensureConnected(el, level);
  resumeContext();
  el.play().catch(() => undefined);
}

/**
 * The music player outlives a page's mount, so a page turn can carry the
 * track (#983, `~/lib/music-carry`). Created on first use, never at import:
 * this module also loads on the server. Never disconnected.
 */
let musicEl: HTMLAudioElement | null = null;
function getMusicEl() {
  if (!musicEl) {
    musicEl = new Audio();
    musicEl.crossOrigin = "anonymous";
    musicEl.loop = true;
    musicEl.preload = "none";
  }
  return musicEl;
}

/** The pending stop's fade-out; a claim cuts it short. */
let musicStopFade: ReturnType<typeof setInterval> | undefined;
const musicCarry = createMusicCarry(() => {
  const el = musicEl;
  if (!el || el.paused) return;
  const gain = ensureConnected(el, 0);
  const startVol = gain.gain.value;
  let i = 0;
  clearInterval(musicStopFade);
  musicStopFade = setInterval(() => {
    i++;
    gain.gain.value = Math.max(0, startVol * (1 - i / FADE_STEPS));
    if (i >= FADE_STEPS) {
      clearInterval(musicStopFade);
      el.pause();
    }
  }, FADE_MS / FADE_STEPS);
});

/**
 * Three-track audio mix for a single panel. Mounts outside the panel-keyed
 * plane (sibling of <PanelViewFrame>) so it stays mounted across panel
 * moves (#974). No <audio> tags are visible: ambience and SFX are two
 * per-mount refs, and music is the module-scoped player above, which a page
 * turn carries (#983).
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
  // This mount's identity for the music carry.
  const [carryOwner] = useState(() => ({}));
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
    applyLevel(musicEl, levels.music);
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
    if (!el) return;
    if (!active || !sfxTag || muted) {
      el.pause();
      return;
    }
    el.src = audioLibraryUrl("sfx", sfxTag);
    el.currentTime = 0;
    playLayer(el, levelsRef.current.sfx);
  }, [sfxTag, active, muted, panel?.id]);

  // ── Music: crossfade on new scene; otherwise continue current bed ──────
  useEffect(() => {
    const targetVol = (volume.music ?? DEFAULT_VOLUME.music) * (muted ? 0 : 1);

    if (!active) {
      if (musicCarry.owns(carryOwner)) musicEl?.pause();
      return;
    }
    musicCarry.claim(carryOwner);
    clearInterval(musicStopFade);
    const el = getMusicEl();
    if (!musicTag) {
      el.pause();
      return;
    }

    const sameScene = sceneId != null && musicCarry.lastSceneId === sceneId;
    const sameMood = musicCarry.lastTag === musicTag;
    const continuePlaying = sameScene || (sameMood && !newScene);
    const url = audioLibraryUrl("music", musicTag);
    const gain = ensureConnected(el, targetVol);

    if (continuePlaying) {
      // A cleanup mid-fade-in leaves the gain partway up the ramp; land on
      // the target rather than staying quieter than the settings ask for.
      gain.gain.value = targetVol;
      if (el.paused) playLayer(el, targetVol);
      musicCarry.lastSceneId = sceneId;
      musicCarry.lastTag = musicTag;
      return;
    }

    // Crossfade: fade out current → swap → fade in
    const startVol = gain.gain.value;
    const stepMs = FADE_MS / FADE_STEPS;
    let i = 0;
    let fadeIn: ReturnType<typeof setInterval> | undefined;
    const fadeOut = setInterval(() => {
      i++;
      gain.gain.value = Math.max(0, startVol * (1 - i / FADE_STEPS));
      if (i >= FADE_STEPS) {
        clearInterval(fadeOut);
        el.pause();
        el.src = url;
        el.load();
        gain.gain.value = 0;
        playLayer(el, 0);
        musicCarry.lastTag = musicTag;
        musicCarry.lastSceneId = sceneId;

        let j = 0;
        fadeIn = setInterval(() => {
          j++;
          gain.gain.value = Math.min(targetVol, targetVol * (j / FADE_STEPS));
          if (j >= FADE_STEPS) clearInterval(fadeIn);
        }, stepMs);
      }
    }, stepMs);
    return () => {
      clearInterval(fadeOut);
      clearInterval(fadeIn);
    };
  }, [musicTag, active, muted, newScene, sceneId, volume.music, carryOwner]);

  // ── Unmount: hand the music to its pending stop, unwire the rest ───────
  useEffect(() => {
    const ambience = ambienceRef.current;
    const sfx = sfxRef.current;
    return () => {
      musicCarry.release(carryOwner);
      // An element bound to the graph can never be bound again, so unwire
      // only one React has taken out of the page. A StrictMode or Fast
      // Refresh pass runs this with the element still in place.
      for (const el of [ambience, sfx]) {
        if (el && !el.isConnected) disconnect(el);
      }
    };
  }, [carryOwner]);

  return (
    <>
      <audio ref={ambienceRef} crossOrigin="anonymous" loop preload="none" />
      <audio ref={sfxRef} crossOrigin="anonymous" preload="none" />
    </>
  );
}
