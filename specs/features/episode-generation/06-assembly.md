# Phase 5 — Assembly

## Status: `pending`
## Prerequisites: Phase 4 complete (all video clips approved)
## Cost: ~$0 (FFmpeg only) + ~$1–5 optional (Venice music)

---

## Purpose

Assemble all approved video clips with their dialogue audio tracks into a final episode MP4. Optionally generate background music via Venice. All work is done locally with FFmpeg.

---

## Command

```bash
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step assemble-audio
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step generate-music   # optional
pnpm generate-episode -- --book tmnt-mmpr-iii --issue 1 --only-step assemble-episode
```

---

## Output

```
assets/episodes/<book>/issue-<n>/assembled/episode-001.mp4
assets/episodes/<book>/issue-<n>/assembled/episode-001-music.mp3   (if music generated)
```

---

## Step: `assemble-audio`

Build a dialogue audio track for each shot.

For each shot in shot-plan.json (in order):

1. Collect audio files: `shot.audioFiles` — these are bubble IDs, map to `assets/comics/<book>/<issue>/audio/<bubbleId>.mp3`
2. If `shot.audioFiles` is empty: generate a silent track matching the clip duration
3. Concatenate bubble MP3s using FFmpeg concat demuxer with 0.3s silence between each line
4. Pad to exactly match the clip duration (clip duration from provenance or snapped value)
5. Output: `assets/episodes/<book>/issue-<n>/audio/shot-NNN-dialogue.mp3`

For silence generation (between lines or padding):
```bash
ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t 0.3 silence-300ms.mp3
```

---

## Step: `generate-music` (optional)

Only runs if `VENICE_GENERATE_MUSIC=true` in `.env`.

1. Determine total episode duration: sum of all shot clip durations
2. Build music prompt:
   - Default: use `series.json` to derive theme: `"[book aesthetic] theme music, instrumental, energetic, [genre]"`
   - Override: `VENICE_MUSIC_PROMPT` env var
3. Submit to Venice audio queue:
   ```json
   POST /audio/queue
   {
     "model": "stable-audio-3",
     "prompt": "90s Saturday morning cartoon action theme, instrumental, upbeat, brass and synth",
     "duration": <total_episode_seconds>,
     "instrumental": true
   }
   ```
4. Poll until complete
5. Save: `assets/episodes/<book>/issue-<n>/assembled/episode-001-music.mp3`

---

## Step: `assemble-episode`

### Sub-step A: Mix audio per shot

For each shot: mix the video's native audio (typically silent) with the dialogue track:

```bash
ffmpeg -i videos/shot-NNN.mp4 -i audio/shot-NNN-dialogue.mp3 \
  -c:v copy -c:a aac -shortest \
  _tmp/shot-NNN-mixed.mp4
```

### Sub-step B: Concatenate all shot clips

Generate `_tmp/concat-list.txt`:
```
file 'shot-001-mixed.mp4'
file 'shot-002-mixed.mp4'
...
```

Run concat:
```bash
ffmpeg -f concat -safe 0 -i _tmp/concat-list.txt \
  -c:v libx264 -crf 20 -preset medium \
  -c:a aac -b:a 192k \
  _tmp/episode-dialogue-only.mp4
```

### Sub-step C: Mix background music (if generated)

If `episode-001-music.mp3` exists:
```bash
ffmpeg -i _tmp/episode-dialogue-only.mp4 -i assembled/episode-001-music.mp3 \
  -filter_complex "[1:a]volume=0.12[bg];[0:a][bg]amix=inputs=2:duration=first[aout]" \
  -map 0:v -map "[aout]" \
  -c:v copy -c:a aac -b:a 192k \
  assembled/episode-001.mp4
```

Music at 12% volume — dialogue always intelligible.

If no music: copy `_tmp/episode-dialogue-only.mp4` → `assembled/episode-001.mp4`.

### Sub-step D: Cleanup

Remove `_tmp/` directory.

### Sub-step E: Log final output

```
✅ Episode assembled

   File:     assets/episodes/tmnt-mmpr-iii/issue-1/assembled/episode-001.mp4
   Duration: 5m 14s
   Size:     412 MB
   Shots:    23
   Spend:    ~$28.40 total

Open episode? [Y/n]
```

`open assembled/episode-001.mp4` — launches QuickTime on macOS.

---

## Copy to Public

After assembly (and once satisfied with the episode), copy to `public/` for Next.js serving:

```bash
cp assets/episodes/<book>/issue-<n>/assembled/episode-001.mp4 \
   public/episodes/<book>/issue-<n>/episode-001.mp4
```

This is a manual step — not run automatically. A future `copy-episode-to-public.ts` script can formalize this.

The Next.js app doesn't yet have an episode player route — that's a future feature. For now, the file is accessible at `/episodes/<book>/issue-<n>/episode-001.mp4`.

---

## FFmpeg Dependency

FFmpeg must be installed on the host machine. The scripts should check at startup:

```bash
ffmpeg -version > /dev/null 2>&1
```

If not found: exit with clear error:
```
❌ FFmpeg not found. Install with: brew install ffmpeg
```

---

## Key Files

- `assets/episodes/<book>/issue-<n>/shot-plan.json` — ordered shot list with audio files
- `assets/episodes/<book>/issue-<n>/videos/shot-NNN.mp4` — approved clips
- `assets/comics/<book>/<issue>/audio/*.mp3` — ElevenLabs dialogue audio
- `assets/episodes/<book>/issue-<n>/review-state.json` — approved shot list
- `scripts/utils/ffmpeg-runner.ts` — FFmpeg command wrappers with error handling
