"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Bubble } from "~/types";

export type BubbleBounds = { x: number; y: number; width: number; height: number };

export type EditChanges = Partial<
  Pick<Bubble, "ocr_text" | "type" | "speaker" | "emotion" | "textWithCues" | "ignored">
> & {
  bounds?: BubbleBounds;
};

export type ReviewEdit = {
  bubbleId: string;
  action: "update" | "delete" | "add";
  changes: EditChanges;
  pageIndex?: number;
  timestamp: number;
};

export type LocalBubble = Bubble & {
  _status?: "modified" | "deleted" | "new" | "redo";
};

const DB_NAME = "comic-review-db";
const STORE_NAME = "edits";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(req.error?.message ?? "IDBOpenDBRequest failed"));
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<ReviewEdit[] | undefined> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as ReviewEdit[] | undefined);
    req.onerror = () => resolve(undefined);
  });
}

function idbPut(db: IDBDatabase, key: string, value: ReviewEdit[]): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
  });
}

export function mergeEdits(originalBubbles: Bubble[], edits: ReviewEdit[]): LocalBubble[] {
  const map = new Map<string, LocalBubble>();
  for (const b of originalBubbles) {
    map.set(b.id, { ...b });
  }

  for (const edit of edits) {
    if (edit.action === "update") {
      const current = map.get(edit.bubbleId);
      if (!current) continue;
      const { bounds, ...rest } = edit.changes;
      const updated: LocalBubble = { ...current, ...rest };
      if (bounds) {
        updated.style = {
          left: `${(bounds.x * 100).toFixed(2)}%`,
          top: `${(bounds.y * 100).toFixed(2)}%`,
          width: `${(bounds.width * 100).toFixed(2)}%`,
          height: `${(bounds.height * 100).toFixed(2)}%`,
        };
      }
      if (current._status !== "redo") updated._status = "modified";
      map.set(edit.bubbleId, updated);
    } else if (edit.action === "delete") {
      const current = map.get(edit.bubbleId);
      if (current) map.set(edit.bubbleId, { ...current, _status: "deleted" });
    } else if (edit.action === "add") {
      const { bounds, ...rest } = edit.changes;
      const style = bounds
        ? {
            left: `${(bounds.x * 100).toFixed(2)}%`,
            top: `${(bounds.y * 100).toFixed(2)}%`,
            width: `${(bounds.width * 100).toFixed(2)}%`,
            height: `${(bounds.height * 100).toFixed(2)}%`,
          }
        : undefined;
      map.set(edit.bubbleId, {
        id: edit.bubbleId,
        box_2d: {},
        ocr_text: rest.ocr_text ?? "",
        type: rest.type ?? "SPEECH",
        speaker: rest.speaker ?? null,
        emotion: rest.emotion ?? "",
        textWithCues: rest.textWithCues,
        style,
        _status: "new",
      });
    }
  }

  return Array.from(map.values());
}

type FixEntry =
  | { bubbleId: string; action: "update"; changes: EditChanges }
  | { bubbleId: string; action: "delete" }
  | { bubbleId: string; action: "add"; pageIndex: number; data: EditChanges };

interface FixesJson {
  bookId: string;
  issueId: string;
  fixes: FixEntry[];
}

export function buildFixesJson(
  bookId: string,
  issueId: string,
  edits: ReviewEdit[],
): FixesJson {
  const byBubble = new Map<string, ReviewEdit[]>();
  for (const edit of edits) {
    const existing = byBubble.get(edit.bubbleId) ?? [];
    byBubble.set(edit.bubbleId, [...existing, edit]);
  }

  const fixes: FixEntry[] = [];

  for (const [bubbleId, bubbleEdits] of byBubble.entries()) {
    const first = bubbleEdits[0];
    const last = bubbleEdits[bubbleEdits.length - 1];
    if (!first || !last) continue;

    const firstAction = first.action;
    const lastAction = last.action;

    // add+delete cancel out
    if (firstAction === "add" && lastAction === "delete") continue;

    if (lastAction === "delete") {
      fixes.push({ bubbleId, action: "delete" });
      continue;
    }

    // Merge all non-delete changes
    const merged: EditChanges = {};
    for (const edit of bubbleEdits) {
      if (edit.action !== "delete") {
        Object.assign(merged, edit.changes);
      }
    }

    if (firstAction === "add") {
      fixes.push({
        bubbleId,
        action: "add",
        pageIndex: first.pageIndex ?? 1,
        data: merged,
      });
    } else {
      if (Object.keys(merged).length > 0) {
        fixes.push({ bubbleId, action: "update", changes: merged });
      }
    }
  }

  return { bookId, issueId, fixes };
}

export function useReviewEdits(bookId: string, issueId: string) {
  const [edits, setEdits] = useState<ReviewEdit[]>([]);
  const [redoSet, setRedoSet] = useState<Set<string>>(new Set());
  const [canUndo, setCanUndo] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const prevEditsRef = useRef<ReviewEdit[] | null>(null);
  const dbRef = useRef<IDBDatabase | null>(null);
  const storeKey = `review-edits-${bookId}-${issueId}`;

  useEffect(() => {
    openDB()
      .then((db) => {
        dbRef.current = db;
        return idbGet(db, storeKey);
      })
      .then((saved) => {
        if (saved) setEdits(saved);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [storeKey]);

  const persist = useCallback(
    (newEdits: ReviewEdit[]) => {
      const db = dbRef.current;
      if (db) void idbPut(db, storeKey, newEdits);
    },
    [storeKey],
  );

  const applyEdit = useCallback(
    (edit: ReviewEdit) => {
      setEdits((prev) => {
        prevEditsRef.current = prev;
        const next = [...prev, edit];
        persist(next);
        return next;
      });
      setCanUndo(true);
    },
    [persist],
  );

  const undoLast = useCallback(() => {
    if (prevEditsRef.current === null) return;
    const prev = prevEditsRef.current;
    prevEditsRef.current = null;
    setEdits(prev);
    persist(prev);
    setCanUndo(false);
  }, [persist]);

  const clearAll = useCallback(() => {
    prevEditsRef.current = null;
    setEdits([]);
    persist([]);
    setRedoSet(new Set());
    setCanUndo(false);
  }, [persist]);

  const toggleRedo = useCallback((bubbleId: string) => {
    setRedoSet((prev) => {
      const next = new Set(prev);
      if (next.has(bubbleId)) next.delete(bubbleId);
      else next.add(bubbleId);
      return next;
    });
  }, []);

  const pendingCount = edits.length;

  return {
    edits,
    applyEdit,
    undoLast,
    canUndo,
    clearAll,
    redoSet,
    toggleRedo,
    loaded,
    pendingCount,
  };
}
