/**
 * The `bubbles` speaker pair for a label from outside text (a fixes file, a
 * local bubbles.json), for the legacy scripts that write one (#463): the
 * name rule from `~/lib/character-aliases` picks the character, and
 * `bubbleSpeaker` pairs `character_id` with `speaker`. A label that matches
 * nothing is tried again with every trailing bracket stripped, the P1
 * backfill's rule ("Red Ranger (Jason)" is Red Ranger). A label that means
 * no character is written as given with a null id; a null label clears both.
 */
import { bubbleSpeaker, type BubbleSpeaker } from "~/lib/bubble-speaker";
import type { NamedCharacter } from "~/lib/character-aliases";

/** "Red Ranger (Jason) (1993)" -> "Red Ranger", as `pg_temp.strip_brackets` does. */
function stripBrackets(label: string): string {
  return label.replace(/(\s*\([^()]*\))+\s*$/, "").trim();
}

/** `means` is the result of `loadNameResolver`, loaded once per run. */
export function labelSpeaker(
  means: (name: string) => NamedCharacter | undefined,
  label: string | null,
): BubbleSpeaker {
  const match = label
    ? (means(label) ?? means(stripBrackets(label)))
    : undefined;
  return bubbleSpeaker(
    match
      ? { id: match.id, displayName: match.display_name ?? match.id }
      : null,
    label,
  );
}
