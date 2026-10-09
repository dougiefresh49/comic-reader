// The design sheet's preview-text rules (#788), shared by the sheet and its
// server actions.

/** Voice Design's limits on the text the takes say, in characters. */
export const PREVIEW_MIN = 100;
export const PREVIEW_MAX = 1000;

export const previewTextOk = (text: string) =>
  text.length >= PREVIEW_MIN && text.length <= PREVIEW_MAX;

/**
 * The default preview text: the character's own lines in reading order,
 * joined with spaces, until it reaches `PREVIEW_MIN` (repeating them when
 * all of them together are shorter), cut at a word boundary to fit
 * `PREVIEW_MAX`. Empty when the character has no lines.
 */
export function defaultPreviewText(lines: string[]): string {
  const said = lines.map((l) => l.trim()).filter(Boolean);
  if (said.length === 0) return "";
  let text = "";
  for (let i = 0; text.length < PREVIEW_MIN; i++) {
    const line = said[i % said.length]!;
    text = text ? `${text} ${line}` : line;
  }
  if (text.length <= PREVIEW_MAX) return text;
  const cut = text.slice(0, PREVIEW_MAX + 1).lastIndexOf(" ");
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, PREVIEW_MAX)).trimEnd();
}
