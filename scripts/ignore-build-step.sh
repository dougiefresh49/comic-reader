#!/bin/bash

# Always build Production (main branch)
if [[ "$VERCEL_ENV" == "production" ]]; then
  exit 1
fi

# Build Previews only when associated with a PR
if [[ "$VERCEL_ENV" == "preview" && -n "$VERCEL_GIT_PULL_REQUEST_ID" ]]; then
  exit 1
fi

# Skip everything else
exit 0
