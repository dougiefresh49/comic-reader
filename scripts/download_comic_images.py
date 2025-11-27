import os
import pathlib
import requests

ROOT = pathlib.Path(__file__).resolve().parent
COMIC_PATH = ROOT / "comics" / "issue-1-hq.md"
OUTPUT_DIR = ROOT / "comics" / "issue-1-hq-images"

def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)

    with COMIC_PATH.open("r", encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]

    for index, url in enumerate(lines, start=1):
        # basic guard: only process lines that look like URLs
        if not (url.startswith("http://") or url.startswith("https://")):
            continue

        filename = f"page-{index:02d}.jpg"
        output_path = OUTPUT_DIR / filename

        print(f"Downloading {url} -> {output_path}")
        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
        except Exception as exc:
            print(f"  FAILED: {exc}")
            continue

        with output_path.open("wb") as img_file:
            img_file.write(resp.content)

    print("Done.")

if __name__ == "__main__":
    main()