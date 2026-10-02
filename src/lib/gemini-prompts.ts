/**
 * Switches for the review editor's analyze call. With none passed, the prompt
 * is the pipeline's get-context prompt, word for word.
 */
export interface ContextPromptOptions {
  /** The speaker must be a name from `uniqueCharacters`, or null. */
  closedList?: boolean;
  /** The region has no text yet: the model reads it and returns it as `text`. */
  transcribe?: boolean;
  /** A close-up crop of the region follows the page image. */
  crop?: boolean;
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
  const castHeading = opts.closedList
    ? "* **Cast (the only names you may give as the speaker):**"
    : "* **Unique Characters:**";
  const locate = opts.transcribe
    ? "Find the target region on the page and read every word inside it, exactly as printed, in reading order. That is `text`. Classify it as one of:"
    : "Find the text on the page. Classify it as one of:";
  const speaker = opts.closedList
    ? "* **Speaker:** If SPEECH, trace the bubble's tail. Who is it? The speaker must be a name from the cast list above, written exactly as listed. Use the list's narrator entry for narration, its off-panel entry for a voice from someone not drawn in the panel, and its crowd entry for many voices at once, when the list has them. If the speaker is not on the list, or you cannot tell, give `null`. Never make up a name; the names in the example below only show the format."
    : "* **Speaker:** If SPEECH, trace the bubble's tail. Who is it? Above is a list of unique characters already identified in the book. If the speaker in this panel looks like one of these characters, reuse the exact name. Only create a new name if it is clearly a different character.";
  const textExample = opts.transcribe ? `  "text": "You'll never win!",\n` : "";

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
        * \`EXTRA\`: Generic/Unnamed (e.g., "Foot Soldier", "Civilian", "Reporter").
    * **Voice Description:** If MINOR or EXTRA, describe their voice for an AI generator. Use their "Side" to influence the tone. (e.g., "Villain Extra: Raspy, aggressive, threatening male voice").
    * **Emotion:** Look at the character's eyebrows, mouth, and body language.

3.  **Performance Cues (CRITICAL):**
    Rewrite the text to guide the voice actor. Use these rules:
    * **Stuttering:** If the character looks scared or text has "...", add stutters like "I-I don't know..."
    * **Volume:** If text is bold or bubble is jagged, add \`[Shouting]\` or \`[Screaming]\` at the start.
    * **Whisper:** If bubble is dotted, add \`[Whispering]\`.
    * **Tone:** Add natural language cues in brackets like \`[sighs]\`, \`[laughs]\`, \`[grunts]\`, or \`[sarcastically]\`.

**Output Format:**
First, think step-by-step in a <scratchpad> block to confirm your reasoning.
Then, provide the final JSON.

**Example Output:**
<scratchpad>
I see the text "You'll never win!". It is in a jagged bubble.
The speaker is a generic Foot Soldier (Villain). He is attacking.
Importance is EXTRA. He is shouting.
</scratchpad>
\`\`\`json
{
  "type": "SPEECH",
  "speaker": "Foot Soldier",
  "characterType": "EXTRA",
  "side": "VILLAIN",
  "voiceDescription": "Aggressive, raspy male voice, American accent, high energy",
  "emotion": "shouting",
${textExample}  "textWithCues": "[Shouting aggressively] You'll never win!"
}
\`\`\`
`;
}
