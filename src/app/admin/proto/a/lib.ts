// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// Small pure helpers shared by the server loader and the client screens.
import type { CastMember } from "./types";

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function titleCase(id: string): string {
  return id
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** The three generic roles of the closed speaker list (owner call O2). */
export const ROLES = [
  { id: "narrator", name: "Narrator", aliases: ["Narration"] },
  {
    id: "off-panel",
    name: "Off-panel",
    aliases: ["Off panel", "Offscreen", "Off-screen"],
  },
  { id: "crowd", name: "Crowd", aliases: [] as string[] },
];

/**
 * A stored speaker string to a cast id, or null when it is not in the closed
 * list. Matches the id, the display name, a full alias, or an alias's first
 * word ("Billy" for "Billy Cranston").
 */
export function resolveSpeaker(
  raw: string | null,
  cast: CastMember[],
): string | null {
  if (!raw) return null;
  const key = slug(raw);
  if (!key) return null;
  for (const c of cast) {
    if (c.id === key || slug(c.name) === key) return c.id;
  }
  for (const c of cast) {
    for (const alias of c.aliases) {
      const a = slug(alias);
      if (a === key || a.split("-")[0] === key) return c.id;
    }
  }
  return null;
}

/** Outline, text and dot classes per speaker. Amber and red stay free for flags. */
const TINTS = [
  { text: "text-sky-300", border: "border-sky-400", dot: "bg-sky-400" },
  {
    text: "text-emerald-300",
    border: "border-emerald-400",
    dot: "bg-emerald-400",
  },
  {
    text: "text-violet-300",
    border: "border-violet-400",
    dot: "bg-violet-400",
  },
  { text: "text-pink-300", border: "border-pink-400", dot: "bg-pink-400" },
  { text: "text-teal-300", border: "border-teal-400", dot: "bg-teal-400" },
  { text: "text-lime-300", border: "border-lime-400", dot: "bg-lime-400" },
  {
    text: "text-indigo-300",
    border: "border-indigo-400",
    dot: "bg-indigo-400",
  },
  { text: "text-rose-300", border: "border-rose-400", dot: "bg-rose-400" },
];
const NEUTRAL_TINT = {
  text: "text-neutral-300",
  border: "border-neutral-400",
  dot: "bg-neutral-400",
};

export type Tint = (typeof TINTS)[number];

/** Characters take tints in cast order, so neighbours in the list never share one. */
export function tintFor(member: CastMember | null | undefined): Tint {
  if (!member || member.kind === "role") return NEUTRAL_TINT;
  return TINTS[member.tint % TINTS.length] ?? NEUTRAL_TINT;
}

export function protoHref(
  path: "" | "/characters" | "/editor",
  book: string,
  issue: string,
  extra?: Record<string, string | number>,
): string {
  const params = new URLSearchParams({ book, issue });
  for (const [k, v] of Object.entries(extra ?? {})) params.set(k, String(v));
  return `/admin/proto/a${path}?${params.toString()}`;
}

/** sessionStorage keys. Nothing here leaves the browser tab. */
export function storageKey(
  part: "doc" | "view" | "chars" | "stage",
  book: string,
  issue: string,
): string {
  return `proto-a:${part}:${book}/${issue}`;
}

export function readSession<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeSession(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* a full or blocked store only costs the refresh-restore */
  }
}

export function clearSession(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}
