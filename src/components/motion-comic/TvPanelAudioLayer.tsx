"use client";

import { useEffect, useRef, useState } from "react";
import { audioLibraryUrl } from "~/lib/audio-library";
import { getAudioContext } from "~/lib/audio-graph";
import { createMusicCarry } from "~/lib/music-carry";
import type { Props } from "./PanelAudioLayer";

const DEFAULT_VOLUME = { ambience: 0.25, sfx: 0.5, music: 0.2 };
const FADE_S = 0.8;
const CACHE_MAX = 6;

/**
 * Decoded tracks by URL, oldest first. Capped because a TV has little
 * memory and a 30 s stereo track decodes to ~11 MB. A failed fetch or
 * decode leaves the map so the next play can try again.
 */
const buffers = new Map<string, Promise<AudioBuffer>>();

function loadBuffer(ctx: AudioContext, url: string) {
  let p = buffers.get(url);
  if (p) {
    buffers.delete(url);
  } else {
    const loading = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`audio ${r.status}`);
        return r.arrayBuffer();
      })
      .then((bytes) => ctx.decodeAudioData(bytes));
    loading.catch(() => {
      if (buffers.get(url) === loading) buffers.delete(url);
    });
    p = loading;
  }
  buffers.set(url, p);
  const oldest = buffers.keys().next().value;
  if (buffers.size > CACHE_MAX && oldest !== undefined) buffers.delete(oldest);
  return p.catch(() => null);
}

interface Playing {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** Context time the source starts at; a crossfade schedules it ahead. */
  at: number;
}

/**
 * Stops `p` once its gain has ramped to 0 over `fadeS` (0 = now). The fade
 * holds the gain where its automation is now rather than reading
 * `gain.value`, which lags the ramps. A source not started yet is silent,
 * so it stops at once.
 */
function release(p: Playing, fadeS: number) {
  const now = p.source.context.currentTime;
  const fade = p.at < now ? fadeS : 0;
  if (fade > 0) {
    const g = p.gain.gain;
    g.cancelAndHoldAtTime(now);
    g.linearRampToValueAtTime(0, now + fade);
  }
  p.source.stop(now + fade);
  if (fade === 0) {
    p.source.disconnect();
    p.gain.disconnect();
  }
}

/**
 * One layer: at most one buffer source, plus the URL it plays or is
 * loading. Each play or stop bumps `gen`, so a decode that lands after the
 * tag changed, the layer stopped, or the reader unmounted starts nothing.
 */
function createLayer(level: () => number) {
  let gen = 0;
  let url: string | null = null;
  let playing: Playing | null = null;
  // Sources still fading out after a crossfade, so `stop` can cut them too.
  const fading = new Set<Playing>();

  return {
    get url() {
      return url;
    },
    /** `restart` replays a URL already playing; `fadeS` crossfades. */
    play(
      next: string,
      { loop = false, restart = false, fadeS = 0 } = {},
    ): void {
      if (next === url && !restart) return;
      const ctx = getAudioContext();
      const my = ++gen;
      url = next;
      const startAt = playing ? ctx.currentTime + fadeS : 0;
      if (playing) {
        release(playing, fadeS);
        fading.add(playing);
      }
      playing = null;
      void loadBuffer(ctx, next).then((buffer) => {
        if (my !== gen) return;
        // Clear the URL so the next play of this track tries again.
        if (!buffer) {
          url = null;
          return;
        }
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = buffer;
        source.loop = loop;
        source.connect(gain).connect(ctx.destination);
        const at = Math.max(startAt, ctx.currentTime);
        if (fadeS > 0) {
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(level(), at + fadeS);
        } else {
          gain.gain.value = level();
        }
        const p = { source, gain, at };
        source.onended = () => {
          source.disconnect();
          gain.disconnect();
          fading.delete(p);
          if (playing === p) playing = null;
        };
        source.start(at);
        playing = p;
      });
    },
    /** `fadeS` fades the source out; sources already fading run on. */
    stop(fadeS = 0): void {
      gen++;
      url = null;
      if (playing) {
        release(playing, fadeS);
        if (fadeS > 0) fading.add(playing);
      }
      playing = null;
      if (fadeS > 0) return;
      for (const p of fading) release(p, 0);
      fading.clear();
    },
    /** Lands on the current level, cutting short any fade-in. */
    applyLevel(): void {
      if (!playing) return;
      const g = playing.gain.gain;
      const now = playing.source.context.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(level(), now);
    },
  };
}

/**
 * The music layer outlives a page's mount, so a page turn can carry the
 * track (#983, `~/lib/music-carry`); ambience and SFX stay per mount. Its
 * level is the latest mount's music setting.
 */
let musicLevel = 0;
const music = createLayer(() => musicLevel);
const musicCarry = createMusicCarry(() => music.stop(FADE_S));

/**
 * TV-mode twin of `PanelAudioLayer`, same props and same behavior, played
 * through Web Audio buffers instead of `<audio>` tags. The TV decodes one
 * media element at a time, and that decoder belongs to the bubble voice
 * (#962); buffers decode in software and leave it free (#965). Every layer
 * runs on the app's one shared context, which is never closed here.
 */
export function TvPanelAudioLayer({
  panel,
  active,
  muted = false,
  volume = DEFAULT_VOLUME,
  newScene = false,
  sceneId = null,
}: Props) {
  // Effective per-layer levels, read when a source starts, so a slider
  // move never re-fires the one-shot sfx or restarts a crossfade.
  const levelsRef = useRef({ ambience: 0, sfx: 0 });
  const [layers] = useState(() => ({
    ambience: createLayer(() => levelsRef.current.ambience),
    sfx: createLayer(() => levelsRef.current.sfx),
  }));
  // This mount's identity for the music carry.
  const [carryOwner] = useState(() => ({}));

  const ambienceTag = panel?.audioTags.ambience[0] ?? null;
  const sfxTag = panel?.audioTags.sfx[0] ?? null;
  const musicTag = panel?.audioTags.music_mood ?? null;

  const on = muted ? 0 : 1;
  const ambienceLevel = (volume.ambience ?? DEFAULT_VOLUME.ambience) * on;
  const sfxLevel = (volume.sfx ?? DEFAULT_VOLUME.sfx) * on;
  const musicVolume = (volume.music ?? DEFAULT_VOLUME.music) * on;

  // ── Volumes ────────────────────────────────────────────────────────────
  useEffect(() => {
    levelsRef.current = { ambience: ambienceLevel, sfx: sfxLevel };
    musicLevel = musicVolume;
    layers.ambience.applyLevel();
    layers.sfx.applyLevel();
    // Only the owner re-applies the shared music level: on a new page's
    // mount it would cancel a carried source's fade-in.
    if (musicCarry.owns(carryOwner)) music.applyLevel();
  }, [ambienceLevel, sfxLevel, musicVolume, layers, carryOwner]);

  // ── Ambience: loop, swap on tag change ─────────────────────────────────
  useEffect(() => {
    if (active && ambienceTag && !muted) {
      layers.ambience.play(audioLibraryUrl("ambience", ambienceTag), {
        loop: true,
      });
    } else {
      layers.ambience.stop();
    }
  }, [ambienceTag, active, muted, layers]);

  // ── SFX: one-shot on panel entry ───────────────────────────────────────
  useEffect(() => {
    if (!active || muted || !sfxTag) {
      layers.sfx.stop();
      return;
    }
    layers.sfx.play(audioLibraryUrl("sfx", sfxTag), { restart: true });
  }, [sfxTag, active, muted, panel?.id, layers]);

  // ── Music: crossfade on new scene; otherwise continue current bed ──────
  useEffect(() => {
    // A stop discards the source, so the next play starts at 0 s: a new
    // page's inactive first render leaves the music to its owner.
    if (!active) {
      if (musicCarry.owns(carryOwner)) music.stop();
      return;
    }
    musicCarry.claim(carryOwner);
    if (!musicTag) {
      music.stop();
      return;
    }
    const sameScene = sceneId != null && musicCarry.lastSceneId === sceneId;
    const sameMood = musicCarry.lastTag === musicTag;
    const url = audioLibraryUrl("music", musicTag);
    if (sameScene || (sameMood && !newScene)) {
      if (!music.url) music.play(url, { loop: true });
    } else {
      music.play(url, { loop: true, restart: true, fadeS: FADE_S });
    }
    musicCarry.lastTag = musicTag;
    musicCarry.lastSceneId = sceneId;
  }, [musicTag, active, newScene, sceneId, carryOwner]);

  // ── Unmount: stop ambience and SFX; music gets a pending stop ──────────
  useEffect(
    () => () => {
      layers.ambience.stop();
      layers.sfx.stop();
      musicCarry.release(carryOwner);
    },
    [layers, carryOwner],
  );

  return null;
}
