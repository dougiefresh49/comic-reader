#!/usr/bin/env node

/**
 * Retired (#429). This script re-called ElevenLabs for the old local
 * pipeline's `bubbles.json`, with each speaker's voice looked up by name in
 * `castlist.json`. Those bubbles carry no `character_id`, so the render
 * chain (`renderVoice` in `~/lib/cast`) cannot key on them, and a name lookup
 * would bill characters the database marks "no audio" or removed. It refuses
 * instead. The previous version is in git history.
 *
 * Supported paths: the review editor's Regenerate (new audio and its word
 * timings together), or `pnpm render-bubble` for one bubble.
 */
console.error(
  "regenerate-timestamps is retired (#429): its bubbles.json has no character_id for the render chain.\n" +
    "Regenerate a bubble's audio and timings through the review editor's Regenerate, " +
    "or `pnpm render-bubble -- --bubble <id> --book <book> --issue <issue>`.",
);
process.exit(1);
