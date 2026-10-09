# Group bubbles: several characters speaking one line at once

Research for [#696](https://github.com/dougiefresh49/comic-reader/issues/696). The known case is POWER-BUNGA!!! on `tmnt-mmpr-iii` issue-2, page 12, which [#621](https://github.com/dougiefresh49/comic-reader/issues/621) moved to Michelangelo alone. No ElevenLabs, Gemini or Roboflow call was made. The DB reads were free SELECTs, and the ElevenLabs pages were read on 2026-10-08.

## Recommendation

Leave group balloons on one lead speaker (option A) and build nothing now. Issues 1 and 2 hold one clear group balloon and one maybe out of 457 bubbles. Every option that lets a kid hear the turtles' own voices together costs 210 to 500 lines, and ElevenLabs offers no documented way to render several voices on the same words at once. When group lines start to matter, build option D: a group cast entry whose clip is a mix of its members' takes, with the lead's timings driving the highlight. It keeps the speaker step, the editor picker and the reader as they are.

## How often it happens

| issue | bubbles | likely group | maybe |
|---|---|---|---|
| issue-1 | 232 | 0 | 0 |
| issue-2 | 225 | 1: page 12, POWER-BUNGA!!! (`70a1fa73`, Michelangelo) | 1: page 11, IT'S MORPHIN TIME! (`e9932752`, Black Ranger) |

- No bubble's `speaker` or `character_id` names a group (turtles, rangers, all, both, crowd and the like). Zero bubbles use the `crowd` role.
- The six zord calls before POWER-BUNGA!!! on page 12 are one balloon and one speaker each, so they are not group balloons.
- IT'S MORPHIN TIME! can be read as the whole team's call, but the text alone can't settle it; the page art can.
- A regex over text, `emotion` and `ai_reasoning` for together, unison, chorus and everyone found about 19 ordinary uses ("WE LET EVERYONE DOWN") and no group-voice cue.
- Issue-3 (200 bubbles, no audio yet) has no clear candidate. `tmnt-mmpr-iii` is the only book with bubble rows in the DB.

## What ElevenLabs can do

It can't render several voices on the same words at the same moment as a documented feature.

- **Text to Dialogue** exists on Eleven v4 and v3 ([capability page](https://elevenlabs.io/docs/overview/capabilities/text-to-dialogue)). `POST /v1/text-to-dialogue` takes `inputs`, a list of `{ text, voice_id }`, with up to 10 unique voice ids and 2,000 characters per request, and `model_id` defaults to `eleven_v3` ([API reference](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert)). The docs describe it as turns, one input per speaker.
- **Its timestamps variant** `POST /v1/text-to-dialogue/with-timestamps` returns per-character `alignment` and `normalized_alignment` plus `voice_segments`, "which voice spoke when", each with `start_time_seconds`, `end_time_seconds` and `dialogue_input_index` ([API reference](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps)). The docs don't say whether segments can overlap in time.
- **Audio tags.** No tag for unison, chorus, crowd or together. `[overlapping]` and `[interrupting]` appear only inside an example dialogue on the [best-practices page](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices), undefined. The launch-era [v3 blog post](https://elevenlabs.io/blog/eleven-v3-audio-tags-bringing-multi-character-dialogue-to-life) promises voices that "interrupt or speak over each other naturally". Both show one turn cutting into the next, not the same words spoken together, and the reference docs guarantee neither.
- **Group voices.** [Voice Design](https://elevenlabs.io/docs/eleven-creative/voices/voice-design) makes one voice from a description; nothing documents a crowd or group voice. [Sound Effects](https://elevenlabs.io/docs/overview/capabilities/sound-effects) returns no timestamps, so it can't drive the highlight.
- **Server-side layering.** Studio and Dubbing Studio have multi-track timelines, but those are editor UIs; no API layers voices for us.
- **Cost.** TTS bills per character, so N takes of the same line cost N times. The docs don't state how Text to Dialogue bills; per input character is the likely reading, which comes to the same N times. POWER-BUNGA!!! is 14 characters, so four turtle takes are about 60 credits per render. Credits are not the deciding cost here; code and mixing are.

## Options

| | What it is | Lines of code | ElevenLabs | What a kid hears |
|---|---|---|---|---|
| **A** | Leave it: one lead speaker per group balloon (today) | 0 | 0 | Michelangelo alone |
| **B** | A group cast entry ("Turtles") with its own designed voice | 0 to 40 | one voice slot and a Voice Design run; one take per render | one synthetic voice, not the turtles |
| **C** | A list of speakers on each bubble; render each take, mix them | 300 to 500 | N takes per render | the four turtles together |
| **D** | A group cast entry whose clip is a mix of its members' takes | 210 to 330 | N takes per render | the four turtles together |
| **E** | Text to Dialogue with `[overlapping]`, one request for all members | about 150 on top of D's data model | a paid test first, about 100 credits | unknown until tested |

### A. Lead speaker (today)

Nothing changes. The lead's take drives audio and highlight as for any bubble. The cost is fidelity on roughly one balloon in 450.

### B. Group cast entry with its own voice

A `characters` row such as `turtles` with a castlist row and a voice. `createCharacter` (`src/lib/cast.ts:896`) already makes the row, and `SpeakerPicker.tsx` and the save path need no change. Making it a fourth role beside narrator, off-panel and crowd (`ROLE_IDS`, `src/lib/cast.ts:31`) touches the editor loader, the characters screen and the get-context prompt, about 20 lines. The catch is that Voice Design makes one voice, so the line still sounds like one person, and it is no longer any turtle a kid knows. The existing `crowd` role already covers many unnamed voices (decision row 229 made the role, and `src/lib/gemini-prompts.ts:61` tells get-context to use it for many unnamed voices at once).

### C. A speaker list per bubble

- **Data.** A `bubbles.speakers` jsonb column beside `character_id`. `save_review_edits` already writes any `bubbles` column, and `switch_bubble_audio_take` already stores one clip and one alignment, so neither changes. A join table instead would need `save_review_edits` extended.
- **Speaker step.** The get-context reply becomes a list: the speaker rule (`src/lib/gemini-prompts.ts:61-62`), the reply's `speaker` field (`:134`), the parsed type (`src/workflows/steps/vision-rows.ts:33`), the row writer (`vision-rows.ts:484-545`) and the editor's analyze path (`src/server/actions/review/analyze-bubble.ts:186`). That is a prompt edit, so it is kid-facing taste work.
- **Editor.** Multi-select in `SpeakerPicker.tsx`, `model.ts` and the inspector, plus the save shape.
- **Render.** `renderVoice` for N characters, N renders in `generation.ts` and `regenerate-audio.ts`, and a new mixer.

The reader is unchanged if the result is one mixed file with the lead's alignment. This is the most flexible option, but it touches every layer for a case seen once.

### D. Group cast entry, mixed from its members (the one to build if needed)

- **Data.** A group is a cast entry, a `characters` row with a member list (a `members text[]` column or a small join table), so the speaker step, the closed cast list, the picker and the save path all treat it as one speaker.
- **Render.** Where `renderVoice` (`src/lib/cast.ts:317-358`) meets a group, it expands it to its members. One render function makes N `convertWithTimestamps` takes, mixes them, and stores one clip with the lead's alignment on the one bubble, which `switch_bubble_audio_take` already does. The generation step and the editor's regenerate call it. `src/lib/render-group-audio.ts` is the model for a shared render function both paths call.
- **Characters screen.** It gains a way to set a group's members.
- **Rough split.** About 210 to 330 lines: migration 20 to 40 lines, render expansion 40 to 60, mixer 80 to 120, regenerate and other call sites 30 to 50, characters screen 40 to 60.

The four protected v2 voices are only used for renders, never edited, so the standing approvals allow it.

### E. Text to Dialogue with `[overlapping]`

One request with an input per member, the same words, each tagged `[overlapping]`. If it overlaps, it saves the mixer and returns one file with an alignment. Nothing in the docs says it will, and how `alignment` and `voice_segments` look for simultaneous inputs is undocumented. It would still need D's data model. It is worth one paid test of about 100 credits before anyone builds D, and only if Doug grants that budget on the issue.

## Word timings and the highlight

All takes say the same words, so one lead take drives the marker, and the other takes are fitted to it.

- **Lead.** The bubble's first-listed member, or the group's first member in D. Its `alignment` is stored in `audio_timestamps` as now, and `useWordHighlight.ts` lights words off it unchanged.
- **Offset.** Shift each other take so its first character starts when the lead's does, from each take's `character_start_times_seconds[0]`.
- **Length drift.** A short shout drifts by tens of milliseconds, which nobody sees. For a longer line, stretch each take to the lead's speech span with ffmpeg `atempo` when the gap passes about 80 ms, then pad to the longest.
- **Gain.** Four different voices on the same shout sum to about +6 dB over one take. `amix`'s default divides each input by the input count (about -12 dB for four), so the mix lands about 6 dB under one take. Set `normalize=0` with each input at about -6 dB, or add about +6 dB after the mix, and check by ear.
- **Tooling.** `ffmpeg-static` and `fluent-ffmpeg` are in `devDependencies` (`package.json:97-98`), imported today only by `scripts/export-episode-mp4.ts` and `scripts/clip-audio-segments.ts`. A mixer in the app's render path moves them to `dependencies` and needs a check that the ffmpeg binary ships in the Vercel build.
- **Merged alignment.** Averaging the takes' timings buys nothing when the words are identical and adds code, so skip it.

## When to reopen

Reopen when a book has group lines in moments a kid cares about, about one or more per issue, or when Doug wants POWER-BUNGA!!! to sound like four turtles. If that happens, run E's paid test first, then build D.
