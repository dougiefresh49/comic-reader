#!/bin/bash
set -euo pipefail

# GitHub Actions sets GITHUB_OUTPUT. For local runs, use a temp file and print it on exit.
if [ -z "${GITHUB_OUTPUT:-}" ]; then
  _RESOLVE_BUMP_OUT="$(mktemp)"
  export GITHUB_OUTPUT="$_RESOLVE_BUMP_OUT"
  trap 'echo "--- GITHUB_OUTPUT (local) ---"; cat "$_RESOLVE_BUMP_OUT" 2>/dev/null || true; rm -f "$_RESOLVE_BUMP_OUT"' EXIT
fi

# Resolve semver bump type from commit messages.
# Priority: explicit [major]/[minor]/[patch] keyword in HEAD commit → Gemini analysis → patch fallback.
# Outputs: bump_type (major|minor|patch)

CURRENT_VERSION=$(node -p "require('./package.json').version")

# Commits since last tag (or all commits if no tags exist)
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)
COMMITS=$(git log "${LAST_TAG}..HEAD" --pretty=format:"%s" -30)

if [ -z "$COMMITS" ]; then
  COMMITS=$(git log -1 --pretty=format:"%s")
fi

HEAD_MSG=$(git log -1 --pretty=format:"%s")

# 1. Check for explicit keyword overrides in the HEAD commit
if echo "$HEAD_MSG" | grep -qi '\[major\]'; then
  echo "bump_type=major" >> "$GITHUB_OUTPUT"
  echo "Resolved bump: major (explicit keyword)"
  exit 0
fi

if echo "$HEAD_MSG" | grep -qi '\[minor\]'; then
  echo "bump_type=minor" >> "$GITHUB_OUTPUT"
  echo "Resolved bump: minor (explicit keyword)"
  exit 0
fi

if echo "$HEAD_MSG" | grep -qi '\[patch\]'; then
  echo "bump_type=patch" >> "$GITHUB_OUTPUT"
  echo "Resolved bump: patch (explicit keyword)"
  exit 0
fi

# 2. Ask Gemini to classify the bump
if [ -n "${GEMINI_API_KEY:-}" ]; then
  PROMPT="You are a semver versioning assistant. Given the current version and recent git commits for a Next.js web application, determine if the next version bump should be major, minor, or patch.

Rules:
- major: breaking changes, large rewrites, incompatible API changes
- minor: new features, significant enhancements, new pages/components
- patch: bug fixes, small tweaks, dependency updates, refactoring, docs, CI/config changes

Current version: ${CURRENT_VERSION}

Recent commits:
${COMMITS}

Reply with exactly one word: major, minor, or patch."

  # Omit maxOutputTokens — use API default so thinking + short answer are not truncated.
  PAYLOAD=$(jq -n --arg prompt "$PROMPT" '{
    contents: [{parts: [{text: $prompt}]}],
    generationConfig: {temperature: 0}
  }')

  RESPONSE=$(curl -sf --max-time 120 \
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>/dev/null || echo "")

  if [ -z "$RESPONSE" ]; then
    echo "Gemini returned empty response (curl failed, timeout, or non-2xx)."
  else
    BUMP=$(echo "$RESPONSE" | jq -r '.candidates[0].content.parts[0].text // ""' | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')

    if [[ "$BUMP" == "major" || "$BUMP" == "minor" || "$BUMP" == "patch" ]]; then
      echo "bump_type=$BUMP" >> "$GITHUB_OUTPUT"
      echo "Resolved bump: ${BUMP} (Gemini)"
      exit 0
    fi

    echo "Gemini response was not usable, falling back to patch"
    echo "Parsed bump candidate (normalized): '${BUMP}'"
    FINISH=$(echo "$RESPONSE" | jq -r '.candidates[0].finishReason // empty')
    if [ -n "$FINISH" ]; then
      echo "Gemini finishReason: ${FINISH}"
    fi
    API_ERR=$(echo "$RESPONSE" | jq -r '.error.message // empty')
    if [ -n "$API_ERR" ]; then
      echo "Gemini API error field: ${API_ERR}"
    fi
    echo "Raw response body (first 2000 chars): ${RESPONSE:0:2000}"
  fi
fi

# 3. Fallback
echo "bump_type=patch" >> "$GITHUB_OUTPUT"
echo "Resolved bump: patch (fallback)"
