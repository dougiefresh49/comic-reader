// localStorage for the review editor: pending edits per issue, and one layout entry for the whole editor.

/** Pending edits and undo history, keyed by book and issue. */
export function editsKey(book: string, issue: string): string {
  return `review-editor:v1:edits:${book}/${issue}`;
}

/** Drawer widths, shared by every issue. */
export const LAYOUT_KEY = "review-editor:v1:layout";

export function readLocal(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** False when the browser refused the write (a full or blocked store). */
export function writeLocal(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearLocal(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}
