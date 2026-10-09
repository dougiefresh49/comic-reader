// What the voices stop's components share: the house classes, the note and run types, and plain words for the plan's internal terms.

import type { ActionResult, ItemRef } from "./actions";
import type { ItemView } from "./types";

// The characters stop's (#349) button and layout classes, so the two stops look alike.
export const BUTTON =
  "inline-flex h-8 shrink-0 items-center rounded-sm border border-neutral-700 px-3 text-[14px] whitespace-nowrap text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800 disabled:border-neutral-800 disabled:text-neutral-600 disabled:hover:bg-transparent";
export const PRIMARY =
  "inline-flex h-8 shrink-0 items-center rounded-sm bg-neutral-100 px-3 text-[14px] font-medium whitespace-nowrap text-neutral-950 hover:bg-white disabled:bg-neutral-700 disabled:text-neutral-400";
export const QUIET =
  "inline-flex h-8 shrink-0 items-center rounded-sm px-2 text-[14px] whitespace-nowrap text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:text-neutral-600 disabled:hover:bg-transparent";
export const SELECT =
  "h-8 min-w-0 max-w-full rounded-sm border border-neutral-700 bg-neutral-950 px-2 text-[14px] text-neutral-100 outline-none focus:border-neutral-400 disabled:text-neutral-500";

export type Note = { text: string; tone: "plain" | "warn"; busy?: true } | null;
export type Run = (label: string, work: () => Promise<ActionResult>) => void;
export type Scope = { bookId: string; issueId: string };

export const refOf = (item: ItemView): ItemRef => ({
  characterId: item.characterId,
  action: item.action,
  targetId: item.target?.id ?? null,
  designedVoices: item.designedVoices,
});

/**
 * The plan's strings name things by their code words (`src/lib/voice-slots`
 * refusal codes, "castlist row", "carryOut"). Cards show them in the owner's
 * words instead; the plan is display-only here (#779), so the swap is on the
 * way to the screen.
 */
const PLAIN: [RegExp, string][] = [
  [/\bno snapshot\b/g, "no backup copy"],
  [/\bbucket copy missing\b/g, "its backup copy is missing"],
  [/\bmd5 mismatch\b/g, "its backup copy does not match the voice"],
  [
    /\bno labels( on the row)?\b/g,
    "its voice library entry lacks the details needed to bring it back",
  ],
  [/\bno description\b/g, "its voice library entry has no description"],
  [/\bkeep_active\b/g, "marked to keep active"],
  [/\broom consumer\b/g, "another project uses it"],
  [/\bneeded by issue\b/g, "this issue still needs it"],
  [/\bno add\/edit headroom\b/g, "no voice changes left this month"],
  [/\badd\/edit headroom\b/g, "voice changes left this month"],
  [/\bcastlist rows?\b/g, "character"],
  [/\bcharacters stop\b/g, "Characters screen"],
  [/\bcarryOut\b/g, "Add"],
  [/\bone GEMINI_MEDIUM call\b/g, "one Gemini call"],
  [/\boutgoing voice\b/g, "voice to archive"],
  [/\bitem\(s\)/g, "items"],
  [/\bvoice\(s\)/g, "voices"],
  [/\badd\(s\)/g, "adds"],
  [/\bthe policy can archive\b/g, "that can be archived"],
];

/** "1 voice", "2 voices". */
const count = (n: string, word: string): string =>
  `${n} ${n === "1" ? word : `${word}s`}`;

/**
 * The plan's page-level refusals (`planVoiceWork` in `~/lib/voice-requests`)
 * as sentences. Matched before `PLAIN`, which would otherwise swap words
 * inside them.
 */
const SENTENCES: [RegExp, (...m: string[]) => string][] = [
  [
    /^(\d+) item\(s\) have no slot: (\d+) free and only (\d+) voice\(s\) the policy can archive$/,
    (_, n, free, can) =>
      `${count(n, "voice")} to add ${n === "1" ? "has" : "have"} no slot: ${count(free, "slot")} free, and ${can === "0" ? "no voice" : `only ${count(can, "voice")}`} can be archived.`,
  ],
  [
    /^(\d+) replacement\(s\) need their old voice archived first and it is refused; pick another voice for each$/,
    (_, n) =>
      n === "1"
        ? "1 new voice needs its old voice archived first, and that voice cannot be archived. Pick another voice to archive for it."
        : `${n} new voices need their old voice archived first, and those voices cannot be archived. Pick another voice to archive for each.`,
  ],
  [
    /^add\/edit headroom (\d+) is below the (\d+) add\(s\) planned$/,
    (_, left, adds) =>
      `${left === "0" ? "No voice changes" : `Only ${count(left, "voice change")}`} left this month, and this list adds ${count(adds, "voice")}.`,
  ],
];

/** A plan string in the owner's words. */
export const plain = (s: string): string => {
  for (const [re, say] of SENTENCES) {
    const m = re.exec(s);
    if (m) return say(...m);
  }
  return PLAIN.reduce((out, [re, words]) => out.replace(re, words), s);
};

/** A refusal list ("no snapshot, no labels") as one clause. */
export const plainList = (reasons: string[]): string =>
  reasons.map(plain).join("; ");

/**
 * Why a voice cannot be archived, as one clause. With no backup copy the
 * clause says what archiving would do to it.
 */
export const archiveWhy = (reasons: string[]): string =>
  reasons
    .map((r) =>
      r === "no snapshot"
        ? "no backup copy, so archiving it would lose it"
        : plain(r),
    )
    .join("; ");
