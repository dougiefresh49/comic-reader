#!/bin/bash

# Always build Production (main branch)
if [[ "$VERCEL_ENV" == "production" ]]; then
  exit 1
fi

# Skip everything but issue branches (issue-N-<slug>, the PR branch rule).
# Keyed on the branch, not the PR id: branches are pushed before their PR
# opens, so the first build would never see a PR id (#162).
if [[ "$VERCEL_ENV" != "preview" || "$VERCEL_GIT_COMMIT_REF" != issue-* ]]; then
  exit 0
fi

# Build an issue branch only when the push changes something that ships:
# scripts/, docs/, specs/ and feedback/ never reach a function (#248).
# git diff exits 0 for no changes, 1 for changes, 128 when the base commit
# is missing from Vercel's shallow clone; only 0 skips the build.
base="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
git diff --quiet "$base" HEAD -- \
  src public \
  next.config.js package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc \
  tsconfig.json postcss.config.js eslint.config.js
if [[ $? -eq 0 ]]; then
  echo "No deployed files changed since $base; skipping the preview."
  exit 0
fi
exit 1
