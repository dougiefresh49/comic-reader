# Prompting ElevenLabs v4

Every take renders on `eleven_v4` (`TTS_MODEL` in `src/lib/tts-request.ts`).
This page says where each piece lives; the code is the source of truth.

## Audio tags and cue text

The rules for writing `text_with_cues` live in `CUE_RULES`,
`src/lib/cue-rules.ts`. Every prompt that writes cues includes that block:
the pipeline's get-context prompt (`buildContextPrompt` in
`src/lib/gemini-prompts.ts`) and the review editor's Regenerate cues
(`buildCuePrompt`). Change the rules there, not in a prompt.

## Voice settings

eleven_v4 uses `stability` and `similarity_boost`. It accepts `style` and
`speed` and ignores them, so the request sends neither (#213 probe,
2026-09-28).

The base for every take is `BASE_VOICE_SETTINGS` in
`src/lib/voice-settings.ts`: stability 0.17, similarity 0.81, the values the
owner heard working in the 2026-10-03 tag test (#412). Tags carry the
emotion; the bubble's `emotion` no longer picks settings.

## Per-voice overrides

A voice can override the base through `voices.voice_settings` (jsonb). Every
key is optional; null or `{}` means no override.

| key                | type           | effect                                      |
| ------------------ | -------------- | ------------------------------------------- |
| `stability`        | number, 0 to 1 | replaces the base stability                 |
| `similarity_boost` | number, 0 to 1 | replaces the base similarity                |
| `line_prefix`      | one audio tag  | goes in front of every line the voice says  |

```json
{ "line_prefix": "[strong Japanese accent]" }
```

`style`, `speed` and `use_speaker_boost` are accepted and not sent: another
consumer of the `voices` table may store them, and the #213 probe found
eleven_v4 ignores `style` and `speed`.
Any other key is an error, so a misspelled `similarityBoost` stops the render
rather than leaving the voice at the base.

`line_prefix` must be one bracketed tag after trimming, e.g.
`[strong Japanese accent]`. An unclosed bracket would leave the reader with
no highlighted words, and a prefix with no brackets would be spoken aloud.
When a line already starts with the voice's prefix (an older or hand-edited
`text_with_cues`), `buildTtsRequest` sends it as it is rather than tagging it
twice.

`parseVoiceOverride` (`src/lib/voice-settings.ts`) reads the value and throws
on an unknown key, a wrong type, a number outside 0 to 1, or a `line_prefix`
that is not one tag, so a bad row stops the render instead of paying for the
wrong settings. `loadVoiceOverrides` (`src/lib/voice-overrides.ts`) reads it
by `current_elevenlabs_id`, and `buildTtsRequest` applies it. The prefix is
billed and appears in the alignment; the reader skips it because
`buildWordTimings` drops bracketed text.

To hear a change before storing it, `pnpm render-bubble` takes
`--stability`, `--similarity` and `--prefix` (a dry run unless
`--execute`). `--prefix` follows the same one-tag rule; `--prefix ""` renders
with no prefix.
