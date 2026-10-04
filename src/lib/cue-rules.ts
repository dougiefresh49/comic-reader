/**
 * The one home for the rules that turn a comic bubble's words into ElevenLabs
 * text: audio tags, punctuation, letter case, and the words that never change.
 *
 * Curated from the ElevenLabs best-practices page, section "Prompting Eleven
 * v4" (Audio tags, Punctuation, Enhancing input), read 2026-10-02:
 * https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices.md
 * and from the owner's eleven_v4 tag test of 2026-10-03 (#412). eleven_v4
 * renders every take (`TTS_MODEL` in `tts-request.ts`).
 *
 * `CUE_RULES` is plain prompt text with no inputs, so any prompt that writes
 * `text_with_cues` includes it: the review editors' Regenerate cues
 * (`buildCuePrompt` below) and the pipeline's cue instruction in
 * `buildContextPrompt` (#213 step 5).
 */
export const CUE_RULES = `## Cue rules

The output is read aloud by ElevenLabs text to speech. Audio tags in square brackets direct how the voice delivers the words; everything outside brackets is spoken.

### The words never change
- Do not add, remove, reorder, respell or translate any word, and never put a word of the line inside brackets. Letter case (below) is the only change allowed to the words.
- Never add letters, repeats or a stutter the comic did not print ("demands" never becomes "demaaands", "I don't" never becomes "I-I don't"), and never take out ones it did print (a printed "NOOOO!" or "N-NO!" keeps every letter). The tag carries the delivery.
- Keep every punctuation mark exactly as written. "..." stays "..." wherever it is, at the start, middle or end: it is the pause and the weight, so never turn it into a dash, never drop it, and never add a pause tag such as [short pause] beside it; the punctuation already carries the pause. "--" stays "--". Do not add or remove "!", "?", "...", commas or dashes.
- If the input already has audio tags in square brackets, they are from an earlier pass: remove them all and write fresh ones. Never keep an old tag beside a new one.

### Letter case
- Comic lettering is printed in capitals, and the voice reads capitals as shouting or hard stress. Write the line in sentence case: a capital for the first word of each sentence, for "I", and for names and proper nouns (people, teams, places), everything else lowercase. Initials and acronyms keep their capitals (NYC, TV, FBI).
- Keep capitals only where the comic clearly shouts or stresses a word:
  - a sound effect or a cry that is the whole line or stands alone in it (BOOM!, WHAM!, AAAGH!);
  - a short shout of one to three words when the emotion says shouting or screaming, or no emotion is given and the line plainly shouts (MASTER!, NO, WAIT!);
  - at most one stressed word in a longer line, and only when the emotion or the words make the stress obvious.
- A longer shouted sentence still goes to sentence case. The tag carries the volume. If one word in it is clearly the stressed one, that word may keep its capitals, e.g. "[shouting, furious] You'll PAY for this!"; if none stands out, capitalize none.
- Text that is already in mixed case keeps its case.

### Audio tags
- A tag describes the voice: its emotion, volume, pace, texture, or a sound the speaker's own voice makes. Write tags that clearly describe the delivery, e.g. [low, gravelly voice], [quietly, with controlled fear], [voice rising into firm resolve], [warm, faint amusement]. Short tags such as [whispers] or [sighs] work too.
- Fit the tag to the moment: the emotion given with the line comes first, then the speaker's character and the words. A wise mentor does not giggle; a hulking brute does not sound timid unless the line says so.
- Put a tag right before the words it colors. A reaction the voice makes, such as [sighs] or [laughs], can go right after the words that cause it. Most lines need one tag at the start; add another only where the delivery changes inside the line. A line that already reads right with no tag can have none.
- Tags can chain when the printed line itself builds; most lines still need only one. In both examples every word outside the brackets was already in the printed line. A reaction can run into a delivery: printed "YOU CALL THAT A PLAN? OH, BRILLIANT." becomes "[starts laughing] You call that a plan? [laughs harder, sarcastic] Oh, brilliant." The delivery can change partway through a line: printed "I'M FINE, I'M FINE... WAIT. WHERE'S THE MAP?" becomes "[gasping] I'm fine, I'm fine... [quiet, slow realization] Wait. Where's the map?"
- These are examples, not the whole set. Write whatever tag the moment needs:
  - delivery: [happy], [sad], [excited], [angry], [annoyed], [appalled], [thoughtful], [surprised], [dismissive], [sarcastic], [curious], [mischievously], [whispers], [shouting], [crying], [sings], [menacing], [reassuring];
  - sounds the voice makes: [laughs], [chuckles], [sighs], [exhales sharply], [inhales deeply], [gasps], [clears throat];
  - an action that changes how the words sound: [mouth full], [chewing, slurred], [out of breath];
  - fuller directions: [low, steady voice, restrained urgency], [softly, with wonder], [warm, conversational tone], [quiet, reflective narration].
- Never write a tag that names an accent, nationality, region or dialect, such as [Italian accent], [strong Japanese accent], [British] or [Southern drawl]. The voice already carries the character's accent.
- Never write a tag for a sound that is not the speaker's voice, such as [explosion], [gunshot], [applause], [crash], [footsteps] or [music]: the model plays those as sound effects. When the words themselves are a sound effect (BOOM!, KRAK!), they stay words for the voice to say; a tag may say how to say them ([loud, forceful voice]) but never names the sound.
- Never write a tag for something no one can hear, such as [standing], [grinning], [pacing] or [points].`;

export interface CuePromptInput {
  /** The text to cue: the bubble's words, possibly with tags from an earlier pass. */
  text: string;
  /** The bubble's emotion as saved, e.g. "Confident and dismissive". Empty or null when none was recorded. */
  emotion: string | null;
  /** The bubble's speaker as saved, a character id such as "leonardo" or "narrator". Null when unassigned. */
  speaker: string | null;
  /** Free-form guidance from the reviewer about why the previous cues did not work. */
  userFeedback?: string;
}

const EXAMPLES = `## Examples

Speaker: raphael
Emotion: Pained and resigned
Input: I GUESS YOU'RE RIGHT. IT'S JUST... DIFFICULT.
Output: [tired, low voice] I guess you're right. [sighs] It's just... difficult.

Speaker: green-ranger
Emotion: Panicked shouting
Input: GET DOWN!
Output: [shouting, panicked] GET DOWN!

Speaker: bebop
Emotion: Mocking
Input: [angry] YOU THINK THAT SCARES ME, TURTLE?
Output: [mocking, gruff voice] You think that scares me, turtle?

Speaker: narrator
Emotion: (none recorded)
Input: MEANWHILE, BENEATH THE STREETS OF NEW YORK...
Output: [quiet, building narration] Meanwhile, beneath the streets of New York...

Speaker: rocksteady
Emotion: Triumphant
Input: KRAKOOM!
Output: [loud, forceful voice] KRAKOOM!`;

/**
 * The full prompt for re-cueing one bubble: the role, the shared cue rules,
 * worked examples, then this bubble's speaker, emotion, optional reviewer
 * feedback and text. Pure, so a script can render the exact prompt the
 * Regenerate cues action sends.
 */
export function buildCuePrompt({
  text,
  emotion,
  speaker,
  userFeedback,
}: CuePromptInput): string {
  const who = speaker?.trim() ? speaker.trim() : "unknown";
  const narration =
    who === "narrator"
      ? " (a narration box: a storyteller's voice, not a character in the scene)"
      : "";
  const mood = emotion?.trim()
    ? emotion.trim()
    : "(none recorded: read the mood from the words)";
  const feedback = userFeedback?.trim()
    ? `\nReviewer feedback on the previous cues (follow it for the tags and the case; it never permits changing the words):\n"${userFeedback.trim()}"\n`
    : "";

  return `You add ElevenLabs audio tags to one line of comic book dialogue so a voice actor model reads it the way the comic means it. Kids follow the words on screen as they are spoken, so the words must stay exactly as written.

${CUE_RULES}

${EXAMPLES}

## This line

Speaker: ${who}${narration}
Emotion: ${mood}
${feedback}Input: ${text.replace(/\s+/g, " ").trim()}

Reply with ONLY the output line: no explanation, no markdown, and no quote marks around it (quote marks that are in the input stay).
Output:`;
}
