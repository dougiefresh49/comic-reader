#!/usr/bin/env python3
"""Speaker diarization for voice clip splitting.

Usage: python diarize.py --input vocals.wav --output segments.json
Requires: pip install pyannote.audio torch
Env: HF_TOKEN (HuggingFace token for pyannote model access)
"""

import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser(description="Speaker diarization")
    parser.add_argument("--input", required=True, help="Input audio file (WAV)")
    parser.add_argument("--output", required=True, help="Output JSON path")
    parser.add_argument(
        "--num-speakers", type=int, default=None, help="Expected number of speakers"
    )
    args = parser.parse_args()

    token = os.environ.get("HF_TOKEN")
    if not token:
        print("ERROR: HF_TOKEN env var required for pyannote model access", file=sys.stderr)
        print("Get one at https://huggingface.co/settings/tokens", file=sys.stderr)
        print("Then accept terms at https://huggingface.co/pyannote/speaker-diarization-3.1", file=sys.stderr)
        sys.exit(1)

    try:
        from pyannote.audio import Pipeline
    except ImportError:
        print("ERROR: pyannote.audio not installed. Run: pip install pyannote.audio", file=sys.stderr)
        sys.exit(1)

    print(f"Loading pyannote speaker-diarization-3.1...")
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1", use_auth_token=token
    )

    # Use MPS on Apple Silicon if available
    device = os.environ.get("TORCH_DEVICE")
    if device:
        import torch
        pipeline.to(torch.device(device))

    print(f"Running diarization on: {args.input}")
    params = {}
    if args.num_speakers:
        params["num_speakers"] = args.num_speakers

    diarization = pipeline(args.input, **params)

    segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append(
            {
                "speaker": speaker,
                "start": round(turn.start, 2),
                "end": round(turn.end, 2),
                "duration": round(turn.end - turn.start, 2),
            }
        )

    # Summarize speakers
    speaker_durations = {}
    for seg in segments:
        sp = seg["speaker"]
        speaker_durations[sp] = speaker_durations.get(sp, 0) + seg["duration"]

    summary = {
        "total_segments": len(segments),
        "speakers": {
            sp: {"total_seconds": round(dur, 1), "segment_count": sum(1 for s in segments if s["speaker"] == sp)}
            for sp, dur in sorted(speaker_durations.items(), key=lambda x: -x[1])
        },
    }

    output = {"summary": summary, "segments": segments}

    with open(args.output, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Done. {len(segments)} segments, {len(speaker_durations)} speakers.")
    for sp, dur in sorted(speaker_durations.items(), key=lambda x: -x[1]):
        print(f"  {sp}: {dur:.1f}s")


if __name__ == "__main__":
    main()
