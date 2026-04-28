#!/usr/bin/env bash
# Prints pipeline checkpoint status for all in-progress comic issues on session start.

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSETS_DIR="$PROJECT_DIR/assets/comics"

echo ""
echo "📚 Comic Reader — Pipeline Status"
echo "──────────────────────────────────────────────────────"

if [ ! -d "$ASSETS_DIR" ]; then
  echo "  No assets directory found. Run: pnpm scrape-pages -- --book <name> --issue <n>"
  echo ""
  exit 0
fi

TOTAL_STEPS=13
found=0

while IFS= read -r -d '' checkpoint_file; do
  found=$((found + 1))
  book=$(jq -r '.book // "unknown"' "$checkpoint_file" 2>/dev/null)
  issue=$(jq -r '.issue // "unknown"' "$checkpoint_file" 2>/dev/null)
  completed=$(jq -r '.completedSteps | length' "$checkpoint_file" 2>/dev/null || echo "0")
  failed=$(jq -r '.failedStep // empty' "$checkpoint_file" 2>/dev/null)
  current=$(jq -r '.currentStep // empty' "$checkpoint_file" 2>/dev/null)

  label="$book / issue-$issue"

  if [ "$completed" -ge "$TOTAL_STEPS" ]; then
    printf "  ✅  %-30s complete (%s/%s steps)\n" "$label" "$completed" "$TOTAL_STEPS"
  elif [ -n "$failed" ]; then
    printf "  ❌  %-30s failed at: %s (%s/%s steps)\n" "$label" "$failed" "$completed" "$TOTAL_STEPS"
  elif [ -n "$current" ]; then
    printf "  ⏳  %-30s running: %s (%s/%s steps)\n" "$label" "$current" "$completed" "$TOTAL_STEPS"
  elif [ "$completed" -gt 0 ]; then
    last=$(jq -r '.completedSteps[-1] // "none"' "$checkpoint_file" 2>/dev/null)
    printf "  ⏸   %-30s paused after: %s (%s/%s steps)\n" "$label" "$last" "$completed" "$TOTAL_STEPS"
  else
    printf "  🆕  %-30s not started\n" "$label"
  fi
done < <(find "$ASSETS_DIR" -name "checkpoint.json" -print0 2>/dev/null)

# Show issue dirs that have pages but no checkpoint
while IFS= read -r -d '' issue_dir; do
  if [ ! -f "$issue_dir/checkpoint.json" ]; then
    pages_count=$(find "$issue_dir/pages" -name "*.jpg" -o -name "*.png" -o -name "*.webp" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$pages_count" -gt 0 ]; then
      rel="${issue_dir#$ASSETS_DIR/}"
      found=$((found + 1))
      printf "  🆕  %-30s not started (%s pages ready)\n" "$rel" "$pages_count"
    fi
  fi
done < <(find "$ASSETS_DIR" -mindepth 2 -maxdepth 2 -type d -print0 2>/dev/null)

if [ "$found" -eq 0 ]; then
  echo "  No comics found. Add pages to assets/comics/<book>/issue-<n>/pages/"
fi

echo "──────────────────────────────────────────────────────"
echo "  Commands: pnpm ingest -- --book <name> --issue <n>"
echo "            pnpm scrape-pages -- --url <url> --book <name> --issue <n>"
echo ""

exit 0
