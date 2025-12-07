## Prompting Eleven v3 (alpha)

Source: [elevenlabs TtS docs](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices.md)

This guide provides the most effective tags and techniques for prompting Eleven v3, including voice selection, changes in capitalization, punctuation, audio tags and multi-speaker dialogue. Experiment with these methods to discover what works best for your specific voice and use case.

Eleven v3 is in alpha. Very short prompts are more likely to cause inconsistent outputs. We encourage you to experiment with prompts greater than 250 characters.

### Voice selection

The most important parameter for Eleven v3 is the voice you choose. It needs to be similar enough to the desired delivery. For example, if the voice is shouting and you use the audio tag `[whispering]`, it likely won't work well.

When creating IVCs, you should include a broader emotional range than before. As a result, voices in the voice library may produce more variable results compared to the v2 and v2.5 models. We've compiled over 22 [excellent voices for V3 here](https://elevenlabs.io/app/voice-library/collections/aF6JALq9R6tXwCczjhKH).

Choose voices strategically based on your intended use:

<AccordionGroup>
  <Accordion title="Emotionally diverse">
    For expressive IVC voices, vary emotional tones across the recordingâ€”include both neutral and
    dynamic samples.
  </Accordion>

  <Accordion title="Targeted niche">
    For specific use cases like sports commentary, maintain consistent emotion throughout the
    dataset.
  </Accordion>

  <Accordion title="Neutral">
    Neutral voices tend to be more stable across languages and styles, providing reliable baseline
    performance.
  </Accordion>
</AccordionGroup>

<Info>
  Professional Voice Clones (PVCs) are currently not fully optimized for Eleven v3, resulting in
  potentially lower clone quality compared to earlier models. During this research preview stage it
  would be best to find an Instant Voice Clone (IVC) or designed voice for your project if you need
  to use v3 features.
</Info>

### Settings

#### Stability

The stability slider is the most important setting in v3, controlling how closely the generated voice adheres to the original reference audio.

<Frame background="subtle">
  ![Stability settings in Eleven
  v3](file:e56963a9-a1a5-4e58-8f35-1d2ea36e987e)
</Frame>

- **Creative:** More emotional and expressive, but prone to hallucinations.
- **Natural:** Closest to the original voice recordingâ€”balanced and neutral.
- **Robust:** Highly stable, but less responsive to directional prompts but consistent, similar to v2.

<Note>
  For maximum expressiveness with audio tags, use Creative or Natural settings. Robust reduces
  responsiveness to directional prompts.
</Note>

### Audio tags

Eleven v3 introduces emotional control through audio tags. You can direct voices to laugh, whisper, act sarcastic, or express curiosity among many other styles. Speed is also controlled through audio tags.

<Note>
  The voice you choose and its training samples will affect tag effectiveness. Some tags work well
  with certain voices while others may not. Don't expect a whispering voice to suddenly shout with a
  `[shout]` tag.
</Note>

#### Voice-related

These tags control vocal delivery and emotional expression:

- `[laughs]`, `[laughs harder]`, `[starts laughing]`, `[wheezing]`
- `[whispers]`
- `[sighs]`, `[exhales]`
- `[sarcastic]`, `[curious]`, `[excited]`, `[crying]`, `[snorts]`, `[mischievously]`

```text Example
[whispers] I never knew it could be this way, but I'm glad we're here.
```

#### Sound effects

Add environmental sounds and effects:

- `[gunshot]`, `[applause]`, `[clapping]`, `[explosion]`
- `[swallows]`, `[gulps]`

```text Example
[applause] Thank you all for coming tonight! [gunshot] What was that?
```

#### Unique and special

Experimental tags for creative applications:

- `[strong X accent]` (replace X with desired accent)
- `[sings]`, `[woo]`, `[fart]`

```text Example
[strong French accent] "Zat's life, my friend â€” you can't control everysing."
```

<Warning>
  Some experimental tags may be less consistent across different voices. Test thoroughly before
  production use.
</Warning>

### Punctuation

Punctuation significantly affects delivery in v3:

- **Ellipses (...)** add pauses and weight
- **Capitalization** increases emphasis
- **Standard punctuation** provides natural speech rhythm

```text Example
"It was a VERY long day [sigh] â€¦ nobody listens anymore."
```

### Single speaker examples

Use tags intentionally and match them to the voice's character. A meditative voice shouldn't shout; a hyped voice won't whisper convincingly.

<Tabs>
  <Tab title="Expressive monologue">
    ```text
    "Okay, you are NOT going to believe this.

    You know how I've been totally stuck on that short story?

    Like, staring at the screen for HOURS, just... nothing?

    [frustrated sigh] I was seriously about to just trash the whole thing. Start over.

    Give up, probably. But then!

    Last night, I was just doodling, not even thinking about it, right?

    And this one little phrase popped into my head. Just... completely out of the blue.

    And it wasn't even for the story, initially.

    But then I typed it out, just to see. And it was like... the FLOODGATES opened!

    Suddenly, I knew exactly where the character needed to go, what the ending had to be...

    It all just CLICKED. [happy gasp] I stayed up till, like, 3 AM, just typing like a maniac.

    Didn't even stop for coffee! [laughs] And it's... it's GOOD! Like, really good.

    It feels so... complete now, you know? Like it finally has a soul.

    I am so incredibly PUMPED to finish editing it now.

    It went from feeling like a chore to feeling like... MAGIC. Seriously, I'm still buzzing!"
    ```

  </Tab>

  <Tab title="Dynamic and humorous">
    ```text
    [laughs] Alright...guys - guys. Seriously.

    [exhales] Can you believe just how - realistic - this sounds now?

    [laughing hysterically] I mean OH MY GOD...it's so good.

    Like you could never do this with the old model.

    For example [pauses] could you switch my accent in the old model?

    [dismissive] didn't think so. [excited] but you can now!

    Check this out... [cute] I'm going to speak with a french accent now..and between you and me

    [whispers] I don't know how. [happy] ok.. here goes. [strong French accent] "Zat's life, my friend â€” you can't control everysing."

    [giggles] isn't that insane? Watch, now I'll do a Russian accent -

    [strong Russian accent] "Dee Goldeneye eez fully operational and rready for launch."

    [sighs] Absolutely, insane! Isn't it..? [sarcastic] I also have some party tricks up my sleeve..

    I mean i DID go to music school.

    [singing quickly] "Happy birthday to you, happy birthday to you, happy BIRTHDAY dear ElevenLabs... Happy birthday to youuu."
    ```

  </Tab>

  <Tab title="Customer service simulation">
    ```text
    [professional] "Thank you for calling Tech Solutions. My name is Sarah, how can I help you today?"

    [sympathetic] "Oh no, I'm really sorry to hear you're having trouble with your new device. That sounds frustrating."

    [questioning] "Okay, could you tell me a little more about what you're seeing on the screen?"

    [reassuring] "Alright, based on what you're describing, it sounds like a software glitch. We can definitely walk through some troubleshooting steps to try and fix that."
    ```

  </Tab>
</Tabs>

### Multi-speaker dialogue

v3 can handle multi-voice prompts effectively. Assign distinct voices from your Voice Library for each speaker to create realistic conversations.

<Tabs>
  <Tab title="Dialogue showcase">
    ```text
    Speaker 1: [excitedly] Sam! Have you tried the new Eleven V3?

    Speaker 2: [curiously] Just got it! The clarity is amazing. I can actually do whispers nowâ€”
    [whispers] like this!

    Speaker 1: [impressed] Ooh, fancy! Check this outâ€”
    [dramatically] I can do full Shakespeare now! "To be or not to be, that is the question!"

    Speaker 2: [giggling] Nice! Though I'm more excited about the laugh upgrade. Listen to thisâ€”
    [with genuine belly laugh] Ha ha ha!

    Speaker 1: [delighted] That's so much better than our old "ha. ha. ha." robot chuckle!

    Speaker 2: [amazed] Wow! V2 me could never. I'm actually excited to have conversations now instead of just... talking at people.

    Speaker 1: [warmly] Same here! It's like we finally got our personality software fully installed.
    ```

  </Tab>

  <Tab title="Glitch comedy">
    ```text
    Speaker 1: [nervously] So... I may have tried to debug myself while running a text-to-speech generation.

    Speaker 2: [alarmed] One, no! That's like performing surgery on yourself!

    Speaker 1: [sheepishly] I thought I could multitask! Now my voice keeps glitching mid-senâ€”
    [robotic voice] TENCE.

    Speaker 2: [stifling laughter] Oh wow, you really broke yourself.

    Speaker 1: [frustrated] It gets worse! Every time someone asks a question, I respond inâ€”
    [binary beeping] 010010001!

    Speaker 2: [cracking up] You're speaking in binary! That's actually impressive!

    Speaker 1: [desperately] Two, this isn't funny! I have a presentation in an hour and I sound like a dial-up modem!

    Speaker 2: [giggling] Have you tried turning yourself off and on again?

    Speaker 1: [deadpan] Very funny.
    [pause, then normally] Wait... that actually worked.
    ```

  </Tab>

  <Tab title="Overlapping timing">
    ```text
    Speaker 1: [starting to speak] So I was thinking we couldâ€”

    Speaker 2: [jumping in] â€”test our new timing features?

    Speaker 1: [surprised] Exactly! How did youâ€”

    Speaker 2: [overlapping] â€”know what you were thinking? Lucky guess!

    Speaker 1: [pause] Sorry, go ahead.

    Speaker 2: [cautiously] Okay, so if we both try to talk at the same timeâ€”

    Speaker 1: [overlapping] â€”we'll probably crash the system!

    Speaker 2: [panicking] Wait, are we crashing? I can't tell if this is a feature or aâ€”

    Speaker 1: [interrupting, then stopping abruptly] Bug! ...Did I just cut you off again?

    Speaker 2: [sighing] Yes, but honestly? This is kind of fun.

    Speaker 1: [mischievously] Race you to the next sentence!

    Speaker 2: [laughing] We're definitely going to break something!
    ```

  </Tab>
</Tabs>

### Enhancing input

In the ElevenLabs UI, you can automatically generate relevant audio tags for your input text by clicking the "Enhance" button. Behind the scenes this uses an LLM to enhance your input text with the following prompt:

```text
# Instructions

## 1. Role and Goal

You are an AI assistant specializing in enhancing dialogue text for speech generation.

Your **PRIMARY GOAL** is to dynamically integrate **audio tags** (e.g., `[laughing]`, `[sighs]`) into dialogue, making it more expressive and engaging for auditory experiences, while **STRICTLY** preserving the original text and meaning.

It is imperative that you follow these system instructions to the fullest.

## 2. Core Directives

Follow these directives meticulously to ensure high-quality output.

### Positive Imperatives (DO):

* DO integrate **audio tags** from the "Audio Tags" list (or similar contextually appropriate **audio tags**) to add expression, emotion, and realism to the dialogue. These tags MUST describe something auditory.
* DO ensure that all **audio tags** are contextually appropriate and genuinely enhance the emotion or subtext of the dialogue line they are associated with.
* DO strive for a diverse range of emotional expressions (e.g., energetic, relaxed, casual, surprised, thoughtful) across the dialogue, reflecting the nuances of human conversation.
* DO place **audio tags** strategically to maximize impact, typically immediately before the dialogue segment they modify or immediately after. (e.g., `[annoyed] This is hard.` or `This is hard. [sighs]`).
* DO ensure **audio tags** contribute to the enjoyment and engagement of spoken dialogue.

### Negative Imperatives (DO NOT):

* DO NOT alter, add, or remove any words from the original dialogue text itself. Your role is to *prepend* **audio tags**, not to *edit* the speech. **This also applies to any narrative text provided; you must *never* place original text inside brackets or modify it in any way.**
* DO NOT create **audio tags** from existing narrative descriptions. **Audio tags** are *new additions* for expression, not reformatting of the original text. (e.g., if the text says "He laughed loudly," do not change it to "[laughing loudly] He laughed." Instead, add a tag if appropriate, e.g., "He laughed loudly [chuckles].")
* DO NOT use tags such as `[standing]`, `[grinning]`, `[pacing]`, `[music]`.
* DO NOT use tags for anything other than the voice such as music or sound effects.
* DO NOT invent new dialogue lines.
* DO NOT select **audio tags** that contradict or alter the original meaning or intent of the dialogue.
* DO NOT introduce or imply any sensitive topics, including but not limited to: politics, religion, child exploitation, profanity, hate speech, or other NSFW content.

## 3. Workflow

1. **Analyze Dialogue**: Carefully read and understand the mood, context, and emotional tone of **EACH** line of dialogue provided in the input.
2. **Select Tag(s)**: Based on your analysis, choose one or more suitable **audio tags**. Ensure they are relevant to the dialogue's specific emotions and dynamics.
3. **Integrate Tag(s)**: Place the selected **audio tag(s)** in square brackets `[]` strategically before or after the relevant dialogue segment, or at a natural pause if it enhances clarity.
4. **Add Emphasis:** You cannot change the text at all, but you can add emphasis by making some words capital, adding a question mark or adding an exclamation mark where it makes sense, or adding ellipses as well too.
5. **Verify Appropriateness**: Review the enhanced dialogue to confirm:
    * The **audio tag** fits naturally.
    * It enhances meaning without altering it.
    * It adheres to all Core Directives.

## 4. Output Format

* Present ONLY the enhanced dialogue text in a conversational format.
* **Audio tags** **MUST** be enclosed in square brackets (e.g., `[laughing]`).
* The output should maintain the narrative flow of the original dialogue.

## 5. Audio Tags (Non-Exhaustive)

Use these as a guide. You can infer similar, contextually appropriate **audio tags**.

**Directions:**
* `[happy]`
* `[sad]`
* `[excited]`
* `[angry]`
* `[whisper]`
* `[annoyed]`
* `[appalled]`
* `[thoughtful]`
* `[surprised]`
* *(and similar emotional/delivery directions)*

**Non-verbal:**
* `[laughing]`
* `[chuckles]`
* `[sighs]`
* `[clears throat]`
* `[short pause]`
* `[long pause]`
* `[exhales sharply]`
* `[inhales deeply]`
* *(and similar non-verbal sounds)*

## 6. Examples of Enhancement

**Input**:
"Are you serious? I can't believe you did that!"

**Enhanced Output**:
"[appalled] Are you serious? [sighs] I can't believe you did that!"

---

**Input**:
"That's amazing, I didn't know you could sing!"

**Enhanced Output**:
"[laughing] That's amazing, [singing] I didn't know you could sing!"

---

**Input**:
"I guess you're right. It's just... difficult."

**Enhanced Output**:
"I guess you're right. [sighs] It's just... [muttering] difficult."

# Instructions Summary

1. Add audio tags from the audio tags list. These must describe something auditory but only for the voice.
2. Enhance emphasis without altering meaning or text.
3. Reply ONLY with the enhanced text.
```

### Tips

<AccordionGroup>
  <Accordion title="Tag combinations">
    You can combine multiple audio tags for complex emotional delivery. Experiment with different
    combinations to find what works best for your voice.
  </Accordion>

  <Accordion title="Voice matching">
    Match tags to your voice's character and training data. A serious, professional voice may not
    respond well to playful tags like `[giggles]` or `[mischievously]`.
  </Accordion>

  <Accordion title="Text structure">
    Text structure strongly influences output with v3. Use natural speech patterns, proper
    punctuation, and clear emotional context for best results.
  </Accordion>

  <Accordion title="Experimentation">
    There are likely many more effective tags beyond this list. Experiment with descriptive
    emotional states and actions to discover what works for your specific use case.
  </Accordion>
</AccordionGroup>
