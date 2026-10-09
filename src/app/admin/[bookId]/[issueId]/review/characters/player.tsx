// One audio element for the casting page: voice previews (`voicePreview`, a
// free signed URL asked on the first Play) and rendered lines. Playing never
// touches the staged moves.
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

interface Player {
  /** The key of what is playing now. */
  playing: string | null;
  /** Voice ids a preview lookup is out for. */
  loading: ReadonlySet<string>;
  /** Voice ids with no stored audio. */
  silent: ReadonlySet<string>;
  playUrl: (key: string, url: string) => void;
  playVoice: (voiceId: string) => void;
  stop: () => void;
}

const PlayerContext = createContext<Player | null>(null);

export function usePlayer(): Player {
  const p = useContext(PlayerContext);
  if (!p) throw new Error("usePlayer outside PlayerProvider");
  return p;
}

export function PlayerProvider({
  preview,
  onError,
  children,
}: {
  preview: (voiceId: string) => Promise<PreviewResult>;
  onError: (message: string) => void;
  children: React.ReactNode;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const urls = useRef(new Map<string, string | null>());
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [silent, setSilent] = useState<ReadonlySet<string>>(new Set());

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

  const playVoice = useCallback(
    (voiceId: string) => {
      const key = `voice:${voiceId}`;
      const known = urls.current.get(voiceId);
      if (known) return playUrl(key, known);
      if (known === null) return;
      setLoading((s) => new Set(s).add(voiceId));
      void preview(voiceId)
        .then((r) => {
          if (!r.ok) {
            onError(r.error);
            return;
          }
          urls.current.set(voiceId, r.url);
          if (r.url) playUrl(key, r.url);
          else setSilent((s) => new Set(s).add(voiceId));
        })
        .catch((err: unknown) =>
          onError(err instanceof Error ? err.message : String(err)),
        )
        .finally(() =>
          setLoading((s) => {
            const next = new Set(s);
            next.delete(voiceId);
            return next;
          }),
        );
    },
    [preview, playUrl, onError],
  );

  const value = useMemo(
    () => ({ playing, loading, silent, playUrl, playVoice, stop }),
    [playing, loading, silent, playUrl, playVoice, stop],
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
      disabled={none || busy}
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
