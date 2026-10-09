import { metadataRefusals } from "~/lib/voice-slots/elevenlabs";

/**
 * Minimal labels for a voice row that has a description and no labels
 * (#786 item 3), so the restore path, which refuses a row without both
 * (`metadataRefusals`), can bring the voice back. The keys follow the
 * voice-lab rows (`language`, `gender`, `age`); `language` is always `en`,
 * and `gender` and `age` are set only when the description names them.
 */
export function minimalLabels(description: string): Record<string, string> {
  const text = ` ${description.toLowerCase()} `;
  const has = (words: string[]) =>
    words.some((w) => new RegExp(`[^a-z]${w}[^a-z]`).test(text));
  const labels: Record<string, string> = { language: "en" };
  const female = has(["female", "woman", "girl", "she", "her", "feminine"]);
  const male = has(["male", "man", "boy", "he", "his", "masculine"]);
  if (female !== male) labels.gender = female ? "female" : "male";
  if (has(["young", "youthful", "teen", "teenage", "teenager", "child", "kid"]))
    labels.age = "young";
  else if (has(["middle-aged", "adult"])) labels.age = "middle-aged";
  else if (has(["old", "elderly", "aged", "ancient", "older"]))
    labels.age = "old";
  return labels;
}

/** True when the row's labels would be refused by the restore path. */
export const labelsMissing = (labels: Record<string, string> | null) =>
  metadataRefusals({ labels }).includes("no labels");

export const blank = (s: string | null | undefined) => !s?.trim();
