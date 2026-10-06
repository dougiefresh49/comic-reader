/**
 * The one place a `bubbles` row's speaker is decided (#463, rule R5 in
 * docs/casting-data-model.html): `character_id` decides who speaks, and
 * `speaker` is the label beside it. Every writer spreads this function's
 * result into its row, so the two columns are always written together.
 * No server-only import: the review editor's client code and the scripts
 * use it too.
 */

/** The two `bubbles` columns that say who speaks. */
export interface BubbleSpeaker {
  character_id: string | null;
  speaker: string | null;
}

/**
 * The `character_id` and `speaker` to write. A picked character writes its
 * id and its display name, or its id when `characters.display_name` is null,
 * so `speaker` has one shape wherever an id is set; callers pass the column
 * as read and apply no fallback of their own. No character writes a null id
 * and the raw label as given, shown until someone picks a speaker; a null
 * label clears both.
 */
export function bubbleSpeaker(
  character: { id: string; displayName: string | null } | null,
  label: string | null,
): BubbleSpeaker {
  if (character)
    return {
      character_id: character.id,
      speaker: character.displayName ?? character.id,
    };
  return { character_id: null, speaker: label };
}
