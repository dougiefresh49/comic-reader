export function buildContextPrompt(
  ocrText: string,
  box: { x: number; y: number; width: number; height: number },
  uniqueCharacters: string[],
  additionalContext?: string,
): string {
  const characterList = uniqueCharacters
    .map((character) => `- ${character}`)
    .join("\n");
  const contextSection = additionalContext
    ? `\n**Book Context:**\n${additionalContext}\n`
    : "";

  return `I am providing a full comic book page.
**Goal:** Analyze the specific text region described below to determine how it should be voice-acted.
${contextSection}
**Target Region:**
* **Text:** "${ocrText}"
* **Location:** x:${box.x}, y:${box.y} (width:${box.width}, height:${box.height})
* **Unique Characters:**
${characterList}

**Instructions:**

1.  **Locate & Classify:** Find the text on the page. Classify it as one of:
    * \`SPEECH\`: Character dialogue (look for a tail pointing to a character).
    * \`NARRATION\`: Square/Rectangular boxes (Storyteller).
    * \`CAPTION\`: Floating structural text ("The End", "NYC").
    * \`SFX\`: Sound effects drawn into the art (BOOM, KRAASH).
    * \`BACKGROUND\`: Text not meant to be read (signs, graffiti, license plates).

2.  **Analyze Context (The "Why"):**
    * **Speaker:** If SPEECH, trace the bubble's tail. Who is it? Above is a list of unique characters already identified in the book. If the speaker in this panel looks like one of these characters, reuse the exact name. Only create a new name if it is clearly a different character.
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
  "textWithCues": "[Shouting aggressively] You'll never win!"
}
\`\`\`
`;
}
