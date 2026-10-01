// localStorage for the review editor: pending edits per issue, and one layout entry for the whole editor.

/** Pending edits and undo history, keyed by book and issue. */
export function editsKey(book: string, issue: string): string {
  return `review-editor:v1:edits:${book}/${issue}`;
}

/** Where a stored value that could not be restored is copied before anything overwrites it. */
export function backupKey(book: string, issue: string): string {
  return `${editsKey(book, issue)}:unreadable`;
}

/** Drawer widths, shared by every issue. */
export const LAYOUT_KEY = "review-editor:v1:layout";

/** The stored string as it is, or null when there is none or the store is blocked. */
export function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readLocal(key: string): unknown {
  try {
    const raw = readRaw(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** False when the browser refused the write (a full or blocked store). */
export function writeRaw(key: string, raw: string): boolean {
  try {
    window.localStorage.setItem(key, raw);
    return true;
  } catch {
    return false;
  }
}

export function writeLocal(key: string, value: unknown): boolean {
  return writeRaw(key, JSON.stringify(value));
}

export function clearLocal(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}
