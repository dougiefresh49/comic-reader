# Audio Layer

## Status: `pending`
## Goal: Three audio tracks — dialogue (existing), ambience+sfx, music — mixed at runtime in the browser, with a content cache so we never pay twice for the same sound
## Lifetime cost target: <$10 across all books, fully cached

---

## Three layers

| Layer | Source | Volume default | Behavior |
|---|---|---|---|
| Dialogue | Existing — ElevenLabs per bubble | 1.0 | Plays on bubble tap or in panel-view auto-play. Karaoke unaffected. |
| Music | New — single track per scene | 0.20 | Fades in/out at scene transitions. Loops if panel duration > track. |
| Ambience + SFX | New — per-panel layer | 0.5 (sfx) / 0.25 (ambience) | Triggered on panel entry. Ambience loops; sfx fires once. |

Three `<audio>` elements per active panel, mixed by HTML5 audio, no Web Audio API needed for v1. If we want gain ducking later (lower music when dialogue plays), upgrade to Web Audio.

---

## Tag → file resolution

Gemini returns symbolic tags like `wind_desert`, `whoosh_metallic_swirl`, `tense_climax`. The renderer resolves each tag to a URL via a layered lookup:

1. **Content-addressed bucket cache:** check `comic-audio/library/<layer>/<tag>.mp3` in Supabase. If present → use it.
2. **Free-library backfill (one-time, manual or scripted):** populate the bucket from Freesound / Pixabay. See "Library bootstrap" below.
3. **AI generation fallback (auto on miss):** if a tag has no cached file, the panel-direction step generates one via ElevenLabs (SFX/music) or Venice (`stable-audio-3`). Result is uploaded to the bucket cache. Future runs hit the cache.

Net effect: most tags are free-library-sourced once and free forever. AI generation is a per-tag one-time cost.

---

## Library bootstrap (one-time)

Script: `scripts/bootstrap-audio-library.ts`

For every entry in `EFFECT_TAGS` (audio half) + `MUSIC_MOODS`:

```
prompt = mapTagToHumanQuery(tag)
candidates = await freesound.search({
  query: prompt,
  filter: 'license:"Creative Commons 0" OR license:"Attribution"',
  fields: 'id,name,download,duration',
  page_size: 5,
})
choose best by duration + tag heuristics
download → upload to comic-audio/library/<layer>/<tag>.mp3
```

Freesound API key: free, register once, store in `.env` as `FREESOUND_API_KEY`. License filter prefers CC0 (no attribution required) and accepts Attribution where CC0 is unavailable; we maintain `comic-audio/library/CREDITS.md` listing all attribution-required sources.

For music moods (~10 entries), Pixabay's music API is gentler than Freesound's mood library — fall back there if Freesound's `tag:music_mood:tense_climax` returns garbage.

**Manual review pass:** after bootstrap, the script writes a static HTML preview page (`audio-library-review.html`) with each tag → audio player. User listens and re-runs `--regenerate <tag>` for any miss.

---

## ElevenLabs SFX generation

Endpoint: `POST https://api.elevenlabs.io/v1/sound-generation`

```ts
const res = await fetch(`${ELEVENLABS}/sound-generation`, {
  method: "POST",
  headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
  body: JSON.stringify({
    text: tagToHumanPrompt(tag),
    duration_seconds: estimateForTag(tag), // 0.5 (sfx) – 6.0 (ambience loop)
    prompt_influence: 0.6,
  }),
});
const buffer = Buffer.from(await res.arrayBuffer());
await supabase.storage
  .from("comic-audio")
  .upload(`library/sfx/${tag}.mp3`, buffer, { upsert: true });
```

Cost: ~$0.01–0.05 per generation depending on duration. With 30–50 SFX tags total, lifetime SFX gen spend is **<$2.50** even if every tag goes to AI gen.

License: ElevenLabs grants commercial use of generated content. For our family-only project: zero concern.

---

## Music generation

Two viable options:

### ElevenLabs Music
`POST /v1/music/compose` — recently launched. Same auth pattern. Supports mood prompts.

### Venice `stable-audio-3`
Already in our `models.ts`. Costs Venice credits (paid). Probably higher quality but eats budget.

**Recommendation:** ElevenLabs Music for music moods, fallback to Venice `stable-audio-3` only if ElevenLabs quality is insufficient. Generate one ~30s loop per mood (~10 moods). Cache forever. Probably <$3 total lifetime.

---

## Caching strategy

Filesystem-style content addressing in the bucket:

```
comic-audio/
  library/
    sfx/
      whoosh_metallic_swirl.mp3
      explosion_distant_muffled.mp3
      ...
    ambience/
      wind_desert.mp3
      city_traffic_distant.mp3
      ...
    music/
      tense_climax.mp3
      action_chase.mp3
      ...
    CREDITS.md       # attribution where required
```

The motion-comic renderer fetches by tag → URL. The bucket is public (no signed URLs needed) for fast playback.

Adding a new tag never invalidates existing cache entries; we just add to the enum + library.

---

## Runtime mixing

```tsx
// inside <PanelView/>
<audio ref={dialogueRef} src={bubble.audioUrl} volume={1.0} />
<audio ref={ambienceRef} src={ambienceUrl} volume={0.25} loop />
<audio ref={sfxRef} src={sfxUrl} volume={0.5} />
<audio ref={musicRef} src={musicUrl} volume={0.20} loop />
```

Volumes exposed in the reader's settings menu so users can mute layers individually. Defaults err quiet — dialogue is always the focus.

Music transitions on `isNewScene === true` between consecutive panels: fade-out current track over 800ms, fade-in next over 800ms.

---

## Audio playback speed

Already covered in the broader Motion Comic Plus overview. Implementation:

```tsx
<audio ref={dialogueRef} playbackRate={audioSpeed} />
```

`audioSpeed` is a per-reader setting (default 1.2 for kid-paced reading; user-configurable). HTML5 `playbackRate` preserves pitch up to 1.5x in modern browsers.

For baked MP4 export (spec 05), apply the equivalent ffmpeg `atempo` filter.

---

## Acceptance test

- After bootstrap, `comic-audio/library/sfx/` contains a file for every SFX tag in the enum
- Open issue-1 page 3 in panel-view auto-play with `audioSpeed=1.2`
- Hear: a low desert wind ambience under the narrator, a metallic whoosh on panel entry, an action-tense music bed at 20% volume
- Toggle music to mute → dialogue + sfx + ambience continue
- Skip to a panel tagged `isNewScene=true` → music crossfades to the new mood
