// Small pure helpers shared by the review editor's loader and its client components.
import type { CastMember, KnownCharacter, VoiceOption } from "./types";

/**
 * A name to a character id. The rule is `slugify` in
 * src/workflows/steps/audio-plan.ts, copied because that file cannot enter a
 * client bundle. The one difference: the name is trimmed first.
 */
export function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** "1 bubble", "2 bubbles". */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function titleCase(id: string): string {
  return id
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const NARRATOR_ID = "narrator";

/** The three generic roles of the closed speaker list. */
export const ROLES = [
  { id: NARRATOR_ID, name: "Narrator", aliases: ["Narration"] },
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

/** "1 needs you", "3 need you". */
export function needYou(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} you`;
}

/** The cast entry a typed name already names: its id, display name or a full alias. */
export function findCast(name: string, cast: CastMember[]): CastMember | null {
  const key = slug(name);
  if (!key) return null;
  return (
    cast.find((c) => c.id === key || slug(c.name) === key) ??
    cast.find((c) => c.aliases.some((a) => slug(a) === key)) ??
    null
  );
}

/** What to show for a cast member's voice, or null when it has none. */
export function voiceLabel(member: CastMember): string | null {
  return member.voice?.name ?? (member.newVoice ? "New voice" : null);
}

/**
 * The voice a typed name already has: its `characters` row's voice, and only
 * when no row matches, an active voice of the same name.
 */
export function ownVoice(
  name: string,
  known: KnownCharacter[],
  voices: VoiceOption[],
): VoiceOption | null {
  const row = matchKnown(name, known);
  if (row) return row.voice;
  const key = slug(name);
  return key ? (voices.find((v) => slug(v.name) === key) ?? null) : null;
}

/** The `characters` row a typed name means: its id, display name or a full alias. */
export function matchKnown(
  name: string,
  known: KnownCharacter[],
): KnownCharacter | null {
  const key = slug(name);
  if (!key) return null;
  return (
    known.find((k) => k.id === key || slug(k.name) === key) ??
    known.find((k) => k.aliases.some((a) => slug(a) === key)) ??
    null
  );
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

/**
 * An id for a bubble or panel made in the browser: a v4 UUID, the shape of
 * `bubbles.id` and `panels.id`, so a save can insert it as it stands.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Plain http (a tailnet address) has no randomUUID; build the same shape.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
