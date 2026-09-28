#!/bin/bash

# Always build Production (main branch)
if [[ "$VERCEL_ENV" == "production" ]]; then
  exit 1
fi

# Build Previews for issue branches (issue-N-<slug>, the PR branch rule).
# Keyed on the branch, not the PR id: branches are pushed before their PR
# opens, so the first build would never see a PR id (#162).
if [[ "$VERCEL_ENV" == "preview" && "$VERCEL_GIT_COMMIT_REF" == issue-* ]]; then
  exit 1
fi

# Skip everything else
exit 0
