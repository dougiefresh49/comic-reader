import { CUE_RULES } from "./cue-rules";

/**
 * Switches for the get-context prompt. The pipeline passes `closedList`,
 * `castNotes` (#354) and `noCues` (#437); the review editor's analyze call
 * passes `closedList`, `transcribe`, `crop` and `noCues` (#460). With none
 * passed, the prompt is the old open-list one, which only scripts still use
 * (`scripts/utils/gemini-context.ts` and `scripts/check-fakes.ts`).
 */
export interface ContextPromptOptions {
  /** The speaker must be a name from the start of a `uniqueCharacters` line, or null. */
  closedList?: boolean;
  /**
   * A line under the cast heading saying how to read the list, for a caller
   * whose entries carry notes after the name (the pipeline's closed cast,
   * `CLOSED_CAST_NOTES` in `vision-rows.ts`). Omitted, nothing is added.
   */
  castNotes?: string;
  /** The region has no text yet: the model reads it and returns it as `text`. */
  transcribe?: boolean;
  /** A close-up crop of the region follows the page image. */
  crop?: boolean;
  /**
   * The speaker call alone (#437): no step 3 "Performance Cues", no
   * `CUE_RULES`, and no `textWithCues` in the example reply. The cue line
   * comes from a second call, `buildCuePrompt` in `cue-rules.ts`.
   */
  noCues?: boolean;
}

export function buildContextPrompt(
  ocrText: string,
  box: { x: number; y: number; width: number; height: number },
  uniqueCharacters: string[],
  additionalContext?: string,
  options?: ContextPromptOptions,
): string {
  const characterList = uniqueCharacters
    .map((character) => `- ${character}`)
    .join("\n");
  const contextSection = additionalContext
    ? `\n**Book Context:**\n${additionalContext}\n`
    : "";
  const opts = options ?? {};

  const images = opts.crop
    ? "I am providing a full comic book page, then a close-up crop of the target region."
    : "I am providing a full comic book page.";
  const textLine = opts.transcribe
    ? "* **Text:** not read yet. Read it from the target region on the page."
    : `* **Text:** "${ocrText}"`;
  const castHeading =
    (opts.closedList
      ? "* **Cast (the only names you may give as the speaker):**"
      : "* **Unique Characters:**") +
    (opts.castNotes ? `\n  ${opts.castNotes}` : "");
  const locate = opts.transcribe
    ? "Find the target region on the page and read every word inside it, exactly as printed, in reading order. That is `text`. Classify it as one of:"
    : "Find the text on the page. Classify it as one of:";
  const speaker = opts.closedList
    ? "* **Speaker:** If SPEECH, trace the bubble's tail. Who is it? The speaker must be the name at the start of a cast line above, with nothing from the parentheses or brackets. A cast member speaking from outside the panel is still that member. Use the list's narrator entry for narration, its crowd entry for many unnamed voices at once, and its off-panel entry only for a voice from outside the panel whose speaker you cannot tell, when the list has them. One figure who is not on the list, or a speaker you cannot tell: give `null`. Never make up a name."
    : "* **Speaker:** If SPEECH, trace the bubble's tail. Who is it? Above is a list of unique characters already identified in the book. If the speaker in this panel looks like one of these characters, reuse the exact name. Only create a new name if it is clearly a different character.";
  // The closed list keeps names that are not on it out of the examples too.
  const extra = opts.closedList
    ? "A generic or unnamed figure. Many of them speaking at once get the list's crowd entry; one of them gets `null` as the speaker, never a description as a name."
    : 'Generic/Unnamed (e.g., "Foot Soldier", "Civilian", "Reporter").';
  const reasoning = opts.closedList
    ? "A row of generic foot soldiers shout it together. Many unnamed voices at once, so the speaker is the list's crowd entry; one foot soldier alone would be `null`. They are attacking.\nImportance is EXTRA. They are shouting."
    : "The speaker is a generic Foot Soldier (Villain). He is attacking.\nImportance is EXTRA. He is shouting.";
  const exampleSpeaker = opts.closedList ? "Crowd" : "Foot Soldier";
  // The example reply's last fields, from emotion on.
  const lastFields = [
    `"emotion": "shouting"`,
    ...(opts.transcribe
      ? [`"text": "You will never defeat us, turtles!"`]
      : []),
    ...(opts.noCues
      ? []
      : [
          `"textWithCues": "[shouting, aggressive] You will never defeat us, turtles!"`,
        ]),
  ]
    .map((field) => `  ${field}`)
    .join(",\n");
  const cueStep = opts.noCues
    ? ""
    : `
3.  **Performance Cues (CRITICAL):**
    Write \`textWithCues\`: the text with ElevenLabs audio tags added, by the cue rules below. Use the speaker and emotion from step 2 and what the page shows: a jagged bubble shouts, a dotted one whispers, and a word lettered bolder or larger than the words around it is the stressed word. The words of \`textWithCues\` are the words of the text, one for one; in the rules below, "the input" is that text and "the output" is \`textWithCues\`.

${CUE_RULES}
`;

  return `${images}
**Goal:** Analyze the specific text region described below to determine how it should be voice-acted.
${contextSection}
**Target Region:**
${textLine}
* **Location:** x:${box.x}, y:${box.y} (width:${box.width}, height:${box.height})
${castHeading}
${characterList}

**Instructions:**

1.  **Locate & Classify:** ${locate}
    * \`SPEECH\`: Character dialogue (look for a tail pointing to a character).
    * \`NARRATION\`: Square/Rectangular boxes (Storyteller).
    * \`CAPTION\`: Floating structural text ("The End", "NYC").
    * \`SFX\`: Sound effects drawn into the art (BOOM, KRAASH).
    * \`BACKGROUND\`: Text not meant to be read (signs, graffiti, license plates).

2.  **Analyze Context (The "Why"):**
    ${speaker}
    * **Side:** Is the speaker a \`HERO\`, \`VILLAIN\`, or \`NEUTRAL\` party?
    * **Importance:**
        * \`MAJOR\`: Main cast (Turtles, Rangers, Shredder, Rita).
        * \`MINOR\`: Named secondary characters (e.g., "Bulk", "Skull").
        * \`EXTRA\`: ${extra}
    * **Voice Description:** If MINOR or EXTRA, describe their voice for an AI generator. Use their "Side" to influence the tone. (e.g., "Villain Extra: Raspy, aggressive, threatening male voice").
    * **Emotion:** Look at the character's eyebrows, mouth, and body language.
${cueStep}
**Output Format:**
First, think step-by-step in a <scratchpad> block to confirm your reasoning.
Then, provide the final JSON.

**Example Output:**
<scratchpad>
I see the text "You will never defeat us, turtles!". It is in a jagged bubble.
${reasoning}
</scratchpad>
\`\`\`json
{
  "type": "SPEECH",
  "speaker": "${exampleSpeaker}",
  "characterType": "EXTRA",
  "side": "VILLAIN",
  "voiceDescription": "Aggressive, raspy male voice, American accent, high energy",
${lastFields}
}
\`\`\`
`;
}

/**
 * The voice-description prompt (#788): one character's per-line voice
 * snippets into one ElevenLabs Voice Design description. The same text
 * `describeVoices` in `src/workflows/steps/voice.ts` sends, which still
 * builds its own copy until it calls this. Word for word: a change here is
 * kid-facing prompt work.
 */
export function voiceDescriptionPrompt(
  name: string,
  snippets: string[],
): string {
  const list = snippets.map((s, idx) => `${idx + 1}. ${s}`).join("\n");

  return `Consolidate these voice description snippets into a single, concise voice description suitable for ElevenLabs voice design. Focus on tone, pitch, accent, and speaking style. Keep it under 100 words.

Character: "${name}"

Snippets:
${list}

Return ONLY the consolidated description as plain text — no JSON, no markdown.`;
}
