// One audio element for the casting page: voice previews (`voicePreview`, a
// free signed URL asked on the first Play) and rendered lines. Playing never
// touches the staged moves; Make a sample (`makeVoiceSample`) is the one paid
// call here, and only on a click that names its cost.
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PreviewResult } from "./actions";
import { FOCUS } from "./ui";

/** Make a sample's price: its characters, and its credits when a rate is measured (#921). */
type SamplePrice = { characters: number; credits: number | null };

interface Player {
  /** The key of what is playing now. */
  playing: string | null;
  /** Voice ids a preview lookup is out for. */
  loading: ReadonlySet<string>;
  /** Voice ids with no audio anywhere, each with what Make a sample costs (null: it cannot make one). */
  silent: ReadonlyMap<string, SamplePrice | null>;
  /** Where each played voice's preview came from ("this book", "sample", ...). */
  sources: ReadonlyMap<string, string>;
  /** Voice ids a Make a sample render is out for. */
  making: ReadonlySet<string>;
  playUrl: (key: string, url: string) => void;
  playVoice: (voiceId: string) => void;
  /** Renders and stores the voice's sample (paid), then plays it. */
  makeSample: (voiceId: string) => void;
  stop: () => void;
}

function withId(s: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return new Set(s).add(id);
}

function withoutId(s: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(s);
  next.delete(id);
  return next;
}

const PlayerContext = createContext<Player | null>(null);

export function usePlayer(): Player {
  const p = useContext(PlayerContext);
  if (!p) throw new Error("usePlayer outside PlayerProvider");
  return p;
}

export function PlayerProvider({
  preview,
  makeSample: make,
  onError,
  children,
}: {
  preview: (voiceId: string) => Promise<PreviewResult>;
  makeSample: (voiceId: string) => Promise<PreviewResult>;
  onError: (message: string) => void;
  children: React.ReactNode;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const urls = useRef(new Map<string, string | null>());
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [silent, setSilent] = useState<ReadonlyMap<string, SamplePrice | null>>(
    new Map(),
  );
  const [sources, setSources] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [making, setMaking] = useState<ReadonlySet<string>>(new Set());
  // Read synchronously, so a second click before the re-render never spends twice.
  const makingNow = useRef(new Set<string>());

  useEffect(() => {
    const el = new Audio();
    el.onended = () => setPlaying(null);
    el.onerror = () => setPlaying(null);
    audio.current = el;
    return () => {
      el.pause();
      audio.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    audio.current?.pause();
    setPlaying(null);
  }, []);

  const current = useRef<string | null>(null);
  useEffect(() => {
    current.current = playing;
  }, [playing]);

  const playUrl = useCallback((key: string, url: string) => {
    const el = audio.current;
    if (!el) return;
    if (current.current === key) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.src = url;
    el.currentTime = 0;
    setPlaying(key);
    void el.play().catch(() => setPlaying(null));
  }, []);

  /** Caches a lookup's answer for the voice and plays its URL, if any. */
  const settle = useCallback(
    (voiceId: string, r: PreviewResult) => {
      if (!r.ok) {
        onError(r.error);
        return;
      }
      urls.current.set(voiceId, r.url);
      if (r.url === null) {
        setSilent((m) => new Map(m).set(voiceId, r.sample));
        return;
      }
      setSources((m) => new Map(m).set(voiceId, r.from));
      setSilent((m) => {
        if (!m.has(voiceId)) return m;
        const next = new Map(m);
        next.delete(voiceId);
        return next;
      });
      playUrl(`voice:${voiceId}`, r.url);
    },
    [playUrl, onError],
  );

  const playVoice = useCallback(
    (voiceId: string) => {
      const known = urls.current.get(voiceId);
      if (known) return playUrl(`voice:${voiceId}`, known);
      if (known === null) return;
      setLoading((s) => withId(s, voiceId));
      void preview(voiceId)
        .then((r) => settle(voiceId, r))
        .catch((err: unknown) =>
          onError(err instanceof Error ? err.message : String(err)),
        )
        .finally(() => setLoading((s) => withoutId(s, voiceId)));
    },
    [preview, playUrl, settle, onError],
  );

  const makeSample = useCallback(
    (voiceId: string) => {
      if (makingNow.current.has(voiceId)) return;
      makingNow.current.add(voiceId);
      setMaking((s) => withId(s, voiceId));
      void make(voiceId)
        .then((r) => settle(voiceId, r))
        .catch((err: unknown) =>
          onError(err instanceof Error ? err.message : String(err)),
        )
        .finally(() => {
          makingNow.current.delete(voiceId);
          setMaking((s) => withoutId(s, voiceId));
        });
    },
    [make, settle, onError],
  );

  const value = useMemo(
    () => ({
      playing,
      loading,
      silent,
      sources,
      making,
      playUrl,
      playVoice,
      makeSample,
      stop,
    }),
    [
      playing,
      loading,
      silent,
      sources,
      making,
      playUrl,
      playVoice,
      makeSample,
      stop,
    ],
  );
  return (
    <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
    </svg>
  );
}

const PLAY =
  "inline-flex shrink-0 items-center justify-center rounded-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:cursor-default disabled:text-neutral-700 disabled:hover:bg-transparent";

/**
 * Play for a voice (asks `voicePreview` on the first click) or for a URL the
 * page already has. A voice with no stored audio keeps a dimmed, disabled
 * button. Never a pick: the click stops at the button.
 */
export function PlayButton({
  name,
  size = "md",
  ...source
}: { name: string; size?: "sm" | "md" } & (
  | { voiceId: string }
  | { url: string; playKey: string }
)) {
  const p = usePlayer();
  const key = "voiceId" in source ? `voice:${source.voiceId}` : source.playKey;
  const isPlaying = p.playing === key;
  const busy = "voiceId" in source && p.loading.has(source.voiceId);
  const none = "voiceId" in source && p.silent.has(source.voiceId);
  return (
    <button
      type="button"
      // Busy stays focusable (aria-disabled): disabling the focused button
      // while its preview loads drops keyboard focus to the page.
      disabled={none}
      aria-disabled={busy || undefined}
      aria-label={
        none
          ? `No stored audio for ${name}`
          : isPlaying
            ? `Stop ${name}`
            : `Play ${name}`
      }
      title={none ? "No stored audio" : isPlaying ? "Stop" : "Play"}
      onClick={(e) => {
        e.stopPropagation();
        if (busy) return;
        if ("voiceId" in source) {
          if (isPlaying) p.stop();
          else p.playVoice(source.voiceId);
        } else p.playUrl(source.playKey, source.url);
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className={`${PLAY} ${FOCUS} ${size === "sm" ? "size-5" : "size-7"} ${
        isPlaying ? "text-amber-400" : ""
      } ${busy ? "animate-pulse" : ""}`}
    >
      {isPlaying ? <StopIcon /> : <PlayIcon />}
    </button>
  );
}

/** Where a played voice's preview came from, a line under its row; nothing before the first Play. */
export function PreviewSource({ voiceId }: { voiceId: string }) {
  const from = usePlayer().sources.get(voiceId);
  return from ? (
    <span
      title={from}
      className="col-span-2 col-start-2 truncate text-[11px] text-neutral-500"
    >
      {from}
    </span>
  ) : null;
}

/**
 * The line under a voice whose Play found no audio anywhere: "no sample
 * yet", and Make a sample with its cost when the voice can render one: in
 * credits at the measured rate, or in characters when no rate is measured
 * (#921). The button is off while its render is out, so a double click
 * spends once.
 * Never a pick: the click and keys stop at the button.
 */
export function MakeSample({
  voiceId,
  name,
}: {
  voiceId: string;
  name: string;
}) {
  const p = usePlayer();
  const sample = p.silent.get(voiceId);
  if (sample === undefined) return null;
  const busy = p.making.has(voiceId);
  // Null when the voice cannot render a sample: no button.
  const cost =
    sample &&
    (sample.credits !== null
      ? `~${sample.credits} credits`
      : `${sample.characters} characters`);
  return (
    <span className="col-span-2 col-start-2 flex min-w-0 items-center gap-1.5 text-[11.5px] text-neutral-500">
      no sample yet
      {cost && (
        <button
          type="button"
          disabled={busy}
          aria-label={`Make a sample of ${name} (${cost})`}
          onClick={(e) => {
            e.stopPropagation();
            p.makeSample(voiceId);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className={`ml-auto shrink-0 rounded-md border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[11px] font-medium text-neutral-200 hover:border-neutral-500 disabled:cursor-wait disabled:opacity-60 disabled:hover:border-neutral-700 ${FOCUS}`}
        >
          {busy ? "Making a sample…" : `Make a sample (${cost})`}
        </button>
      )}
    </span>
  );
}
