// Hear a bubble in the editor, and regenerate its cues or audio through the review actions, after a Save when it has pending edits.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveEdits } from "~/app/api/apply-fixes/write-rules";
import { audioUrl } from "~/lib/storage";
import { regenerateAudio } from "~/server/actions/review/regenerate-audio";
import { regenerateCues } from "~/server/actions/review/regenerate-cues";
import type { SrcBubble } from "./types";

export type ListenJob = "cues" | "audio";

/** What the last play or regenerate of a bubble came to, shown next to the controls. */
export interface ListenNotice {
  tone: "ok" | "error";
  text: string;
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
  /** A Save is in flight: the editor is locked and no regenerate may start. */
  saveRunning: () => boolean;
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
  saveRunning,
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
  const [notices, setNotices] = useState<Record<string, ListenNotice | null>>(
    {},
  );
  const [playing, setPlaying] = useState<string | null>(null);
  /**
   * The one regenerate running in the editor, its save-first included. While
   * it runs the editor is locked, so nothing can change under it.
   */
  const [active, setActive] = useState<{ id: string; job: ListenJob } | null>(
    null,
  );
  const activeRef = useRef(active);

  // Calls land long after the click, so they read the latest through refs.
  const pathsRef = useRef(paths);
  const playingRef = useRef(playing);
  const saveRunningRef = useRef(saveRunning);
  const saveFirstRef = useRef(saveFirst);
  const onCuesRef = useRef(onCues);
  useEffect(() => {
    pathsRef.current = paths;
    saveRunningRef.current = saveRunning;
    saveFirstRef.current = saveFirst;
    onCuesRef.current = onCues;
  });
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const note = useCallback((id: string, notice: ListenNotice | null) => {
    setNotices((prev) => ({ ...prev, [id]: notice }));
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
      note(id, null);
      const failed = (why: string) => {
        if (audioRef.current !== audio) return;
        stop();
        note(id, { tone: "error", text: `The take did not play (${why}).` });
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
    [bookId, issueId, note, stop],
  );

  // Another bubble selected, or none: playback stops. So does leaving the editor.
  useEffect(() => {
    if (playingRef.current && playingRef.current !== selectedId) stop();
  }, [selectedId, stop]);
  useEffect(() => stop, [stop]);

  // A reload mid-regenerate drops the lock while the paid call runs on, and
  // invites a second paid click: the browser asks before leaving.
  useEffect(() => {
    if (!active) return;
    const hold = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [active]);

  /**
   * Regenerate the bubble's cues or audio: Save first when it has pending
   * edits, and call the action only once that Save has landed. Refused, and
   * false, while a Save or another regenerate holds the editor.
   */
  const regenerate = useCallback(
    (id: string, job: ListenJob): boolean => {
      if (activeRef.current || saveRunningRef.current()) return false;
      activeRef.current = { id, job };
      setActive(activeRef.current);
      note(id, null);
      void (async () => {
        try {
          const saved = await saveFirstRef.current(id);
          if (!saved.ok) {
            note(id, {
              tone: "error",
              text: `Nothing was regenerated: the Save before it did not go through. ${saved.error}`,
            });
            return;
          }
          if (job === "cues") {
            const row = bubbles.find((b) => b.id === id);
            const res = await regenerateCues({
              bookId,
              issueId,
              bubbleId: id,
              text: saved.text,
              emotion: row?.emotion ?? null,
              speaker: row?.speaker ?? null,
            });
            if (res.ok && res.textWithCues) {
              onCuesRef.current(id, saved.text, res.textWithCues);
              note(id, {
                tone: "ok",
                text: "New cues saved. The audio reads the old cues until you regenerate it.",
              });
            } else {
              note(id, {
                tone: "error",
                text: res.error ?? "Regenerate cues failed.",
              });
            }
            return;
          }
          const res = await regenerateAudio({ bookId, issueId, bubbleId: id });
          if (res.ok && res.audioStoragePath) {
            const path = res.audioStoragePath;
            if (playingRef.current === id) stop();
            setPaths((prev) => ({ ...prev, [id]: path }));
            note(id, { tone: "ok", text: "New take saved. L plays it." });
          } else {
            note(id, {
              tone: "error",
              text: res.error ?? "Regenerate audio failed.",
            });
          }
        } catch (e) {
          // No answer from the server: the call may or may not have run.
          const why = (e as Error).message;
          note(id, {
            tone: "error",
            text:
              job === "cues"
                ? `Regenerate cues got no answer (${why}). The new cues may have saved; reload the editor to see.`
                : `Regenerate audio got no answer (${why}). ElevenLabs may have made and charged for a take; reload the editor to see whether this bubble has a new one. Regenerating will spend ElevenLabs credits again.`,
          });
        } finally {
          activeRef.current = null;
          setActive(null);
        }
      })();
      return true;
    },
    [bookId, issueId, bubbles, note, stop],
  );

  /**
   * A Save landed: the takes it dropped are gone from the rows, so they leave
   * playback too, and one playing stops.
   */
  const dropTakes = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      if (playingRef.current && ids.includes(playingRef.current)) stop();
      setPaths((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
    },
    [stop],
  );

  return {
    paths,
    notices,
    playing,
    play,
    /** The regenerate holding the editor, or null. */
    active,
    /** Read at the moment of an action, before a render catches up. */
    isActive: () => activeRef.current !== null,
    regenerate,
    dropTakes,
  };
}

/**
 * The bubbles whose take a Save leaves with no `audio_storage_path`: a
 * removed row, an inserted one, and one marked silent. The rule this follows
 * lives in `bubbleUpdate` and `bubbleInsert` in
 * `src/app/api/apply-fixes/write-rules.ts`.
 */
export function takesDropped(edits: SaveEdits): string[] {
  return [
    ...edits.bubbles.remove.map((r) => r.id),
    ...edits.bubbles.add.map((r) => r.id),
    ...edits.bubbles.update
      .filter((r) => r.set.silent === true)
      .map((r) => r.id),
  ];
}
