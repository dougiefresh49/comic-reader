// Hear a bubble in the editor, and regenerate its cues or audio through the review actions, after a Save when it has pending edits.
import { useCallback, useEffect, useRef, useState } from "react";
import { audioUrl } from "~/lib/storage";
import { regenerateAudio } from "~/server/actions/review/regenerate-audio";
import { regenerateCues } from "~/server/actions/review/regenerate-cues";
import type { SrcBubble } from "./types";

export type ListenJob = "cues" | "audio";

export interface ListenRun {
  /** The call in flight, or null. Both controls are off while one runs. */
  running: ListenJob | null;
  /** What the last play or call came to, shown next to the controls. */
  notice: { tone: "ok" | "error"; text: string } | null;
}

/** What `saveFirst` comes to: the row's saved text, or why it is not saved. */
export type SavedRow =
  | { ok: true; text: string }
  | { ok: false; error: string };

interface UseListenArgs {
  bookId: string;
  issueId: string;
  bubbles: SrcBubble[];
  /** The selected bubble: choosing another one stops playback. */
  selectedId: string | null;
  /** Save when this bubble has a pending edit (part 2's Save), then the row as saved. */
  saveFirst: (id: string) => Promise<SavedRow>;
  /** Regenerate cues wrote the row's cues for this text. */
  onCues: (id: string, forText: string, value: string) => void;
}

export function useListen({
  bookId,
  issueId,
  bubbles,
  selectedId,
  saveFirst,
  onCues,
}: UseListenArgs) {
  // Each regenerated take gets a path no earlier take used, so a new path is
  // never served from the browser's cache and needs no cache-busting query.
  const [paths, setPaths] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const b of bubbles) if (b.audioPath) out[b.id] = b.audioPath;
    return out;
  });
  const [runs, setRuns] = useState<Record<string, ListenRun>>({});
  const [playing, setPlaying] = useState<string | null>(null);

  // Calls land long after the click, so they read the latest through refs.
  const pathsRef = useRef(paths);
  const playingRef = useRef(playing);
  const saveFirstRef = useRef(saveFirst);
  const onCuesRef = useRef(onCues);
  useEffect(() => {
    pathsRef.current = paths;
    saveFirstRef.current = saveFirst;
    onCuesRef.current = onCues;
  });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Bubbles with a call in flight, checked before any state update lands. */
  const busy = useRef(new Set<string>());

  const put = useCallback((id: string, run: Partial<ListenRun>) => {
    setRuns((prev) => ({
      ...prev,
      [id]: { running: null, notice: null, ...prev[id], ...run },
    }));
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    audio?.pause();
    playingRef.current = null;
    setPlaying(null);
  }, []);

  /** Play the bubble's current take; on the bubble already playing, stop. */
  const play = useCallback(
    (id: string) => {
      if (playingRef.current === id) {
        stop();
        return;
      }
      stop();
      const path = pathsRef.current[id];
      if (!path) return;
      const audio = new Audio(audioUrl(bookId, issueId, path));
      audioRef.current = audio;
      playingRef.current = id;
      setPlaying(id);
      put(id, { notice: null });
      const failed = (why: string) => {
        if (audioRef.current !== audio) return;
        stop();
        put(id, {
          notice: { tone: "error", text: `The take did not play (${why}).` },
        });
      };
      audio.addEventListener("ended", () => {
        if (audioRef.current === audio) stop();
      });
      audio.addEventListener("error", () => {
        // The message is often empty; the code always says which failure.
        const media = audio.error;
        const detail = media?.message ? `: ${media.message}` : "";
        failed(`media error ${media?.code ?? "unknown"}${detail}`);
      });
      audio.play().catch((e: Error) => failed(e.message));
    },
    [bookId, issueId, put, stop],
  );

  // Another bubble selected, or none: playback stops. So does leaving the editor.
  useEffect(() => {
    if (playingRef.current && playingRef.current !== selectedId) stop();
  }, [selectedId, stop]);
  useEffect(() => stop, [stop]);

  /**
   * Regenerate the bubble's cues or audio: Save first when it has pending
   * edits, and call the action only once that Save has landed.
   */
  const regenerate = useCallback(
    async (id: string, job: ListenJob) => {
      if (busy.current.has(id)) return;
      busy.current.add(id);
      put(id, { running: job, notice: null });
      try {
        const saved = await saveFirstRef.current(id);
        if (!saved.ok) {
          put(id, {
            notice: {
              tone: "error",
              text: `Nothing was regenerated: the Save before it did not go through. ${saved.error}`,
            },
          });
          return;
        }
        if (job === "cues") {
          const res = await regenerateCues({
            bookId,
            issueId,
            bubbleId: id,
            text: saved.text,
          });
          if (res.ok && res.textWithCues) {
            onCuesRef.current(id, saved.text, res.textWithCues);
            put(id, {
              notice: {
                tone: "ok",
                text: "New cues saved. The audio reads the old cues until you regenerate it.",
              },
            });
          } else {
            put(id, {
              notice: {
                tone: "error",
                text: res.error ?? "Regenerate cues failed.",
              },
            });
          }
          return;
        }
        const res = await regenerateAudio({ bookId, issueId, bubbleId: id });
        if (res.ok && res.audioStoragePath) {
          const path = res.audioStoragePath;
          if (playingRef.current === id) stop();
          setPaths((prev) => ({ ...prev, [id]: path }));
          put(id, {
            notice: { tone: "ok", text: "New take saved. L plays it." },
          });
        } else {
          put(id, {
            notice: {
              tone: "error",
              text: res.error ?? "Regenerate audio failed.",
            },
          });
        }
      } catch (e) {
        // No answer from the server: the call may or may not have run.
        const why = (e as Error).message;
        put(id, {
          notice: {
            tone: "error",
            text:
              job === "cues"
                ? `Regenerate cues got no answer (${why}). The new cues may have saved; reload the editor to see.`
                : `Regenerate audio got no answer (${why}). ElevenLabs may have made and charged for a take; reload the editor to see whether this bubble has a new one. Regenerating will spend ElevenLabs credits again.`,
          },
        });
      } finally {
        busy.current.delete(id);
        put(id, { running: null });
      }
    },
    [bookId, issueId, put, stop],
  );

  return { paths, runs, playing, play, regenerate };
}
