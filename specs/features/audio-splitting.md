# Feature: Voice Clip Splitting Tool

## Status: `pending`

---

## Purpose

When sourcing voice clips for character IVC creation, the downloaded audio (usually from YouTube) typically contains multiple speakers, background music, and sound effects. ElevenLabs IVC training requires clean, single-speaker audio (minimum ~1 minute of speech).

This tool automates the isolation of a target character's voice from mixed audio, producing a clean clip ready for ElevenLabs upload.

---

## Workflow

```
Input:  downloaded clip (MP3/MP4/WAV) with mixed audio
                    │
         ┌──────────┴──────────┐
         │  1. Source Separation │  (remove music + SFX)
         │     audio-separator   │
         └──────────┬──────────┘
                    │
         ┌──────────┴──────────┐
         │  2. Transcription +  │  (identify WHO speaks WHEN)
         │     Diarization      │
         │     whisper + pyannote│
         └──────────┬──────────┘
                    │
         ┌──────────┴──────────┐
         │  3. Speaker Identify │  (match speaker labels to character)
         │     Gemini Flash     │
         └──────────┬──────────┘
                    │
         ┌──────────┴──────────┐
         │  4. Extract + Concat │  (slice target speaker segments)
         │     ffmpeg            │
         └──────────┬──────────┘
                    │
Output: clean isolated voice clip (WAV, single speaker)
```

---

## Dependencies

```bash
# Python (source separation + diarization)
pip install audio-separator[cpu] pyannote.audio

# System (already available)
brew install ffmpeg

# HuggingFace token needed for pyannote models (free, one-time accept)
# Set HF_TOKEN env var or run `huggingface-cli login`
```

---

## Script: `scripts/split-voice-clip.ts`

```bash
pnpm split-voice -- --input clip.mp4 --character "Raphael" --output isolated.wav
pnpm split-voice -- --input clip.mp4 --character "Raphael" --book tmnt-mmpr-iii
```

### Options

| Flag | Description |
|------|-------------|
| `--input` | Path to source audio/video file |
| `--character` | Target character name to isolate |
| `--output` | Output path (default: `{input-stem}_isolated.wav`) |
| `--book` | Optional: if provided, uses book context to help Gemini identify the character |
| `--min-duration` | Minimum output duration in seconds (default: 60) |
| `--skip-separation` | Skip vocal isolation step (if input is already voice-only) |
| `--keep-intermediates` | Keep temp files (separated vocals, diarization JSON) |

### Steps in Detail

**Step 1: Source Separation** — Uses `audio-separator` with MDX-Net model to isolate vocals from instrumentals. Spawns Python subprocess:
```bash
audio-separator input.mp4 --model_filename UVR-MDX-NET-Inst_HQ_3.onnx --output_dir /tmp/split-{hash}/
```
Output: `vocals.wav` (speech only, no music/SFX)

**Step 2: Transcription + Diarization** — Uses pyannote speaker diarization via a small Python helper script (`scripts/helpers/diarize.py`):
- Runs pyannote's speaker-diarization-3.1 pipeline on the vocals
- Runs Whisper (via pyannote's built-in ASR or standalone) for transcript
- Outputs JSON: `{ segments: [{ speaker: "SPEAKER_00", start: 0.5, end: 3.2, text: "..." }] }`

**Step 3: Speaker Identification** — Feeds the transcript segments to Gemini Flash:
- Prompt: "Given these dialogue segments from [show/character context], identify which SPEAKER_XX label corresponds to [character name]"
- Uses `GEMINI_MEDIUM` for the identification call
- Falls back to interactive selection if Gemini is unsure (lists speakers with sample text, user picks)

**Step 4: Extract + Concatenate** — Uses ffmpeg to:
- Slice all segments belonging to the target speaker
- Add 0.1s silence padding between segments (natural breaks)
- Concatenate into final output WAV
- Validate duration meets minimum (warn if too short)

---

## Python Helper: `scripts/helpers/diarize.py`

Small self-contained Python script called by the TypeScript orchestrator:

```python
#!/usr/bin/env python3
"""Speaker diarization + transcription for voice clip splitting."""
# Usage: python diarize.py --input vocals.wav --output segments.json
# Requires: pip install pyannote.audio torch
# Env: HF_TOKEN (HuggingFace token for pyannote model access)

import argparse, json, os
from pyannote.audio import Pipeline

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=os.environ["HF_TOKEN"]
    )
    diarization = pipeline(args.input)

    segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append({
            "speaker": speaker,
            "start": round(turn.start, 2),
            "end": round(turn.end, 2),
        })

    with open(args.output, "w") as f:
        json.dump({"segments": segments}, f, indent=2)

if __name__ == "__main__":
    main()
```

---

## Integration with Casting Pipeline

The split tool is standalone but integrates naturally with the casting workflow:

1. User clicks YouTube search links in the Casting UI
2. Downloads full clip via yt-dlp (existing `youtube-dl-exec` in stack)
3. Runs `pnpm split-voice -- --input clip.mp4 --character "Goldar" --book tmnt-mmpr-iii`
4. Gets clean isolated clip → uploads to ElevenLabs dashboard for IVC creation
5. Pastes resulting voice ID back into Casting UI

Future: the split step could run server-side after yt-dlp download, before ElevenLabs upload. But for now, keeping it local avoids deploying Python + large ML models to production.

---

## Environment Variables

```bash
# Required for pyannote model access
HF_TOKEN=hf_...

# Optional: use GPU for faster processing
TORCH_DEVICE=mps  # Apple Silicon GPU via Metal Performance Shaders
```

---

## Verification

```bash
# Basic test with a known clip
pnpm split-voice -- --input ~/Downloads/raphael-clip.mp4 --character "Raphael"
# → outputs raphael-clip_isolated.wav
# → prints duration and speaker stats

# Check output quality
ffprobe raphael-clip_isolated.wav
# → verify mono/stereo, sample rate, duration ≥ 60s

# Upload to ElevenLabs and create test IVC
```

---

## Build Order

1. **`scripts/helpers/diarize.py`** — Python diarization helper
2. **`scripts/split-voice-clip.ts`** — TypeScript orchestrator
3. **`package.json`** — Add `"split-voice"` script entry
4. **Documentation** — Add to CLAUDE.md pipeline table as manual script

---

## Notes

- First run will download ~1.5 GB of ML models (MDX-Net + pyannote). Subsequent runs are fast.
- Apple Silicon users: set `TORCH_DEVICE=mps` for GPU-accelerated diarization (~3x faster).
- For very short clips (< 60s usable speech), the tool warns but still outputs what it found.
- ElevenLabs recommends WAV 44.1kHz for best IVC quality; the tool outputs at source sample rate.
