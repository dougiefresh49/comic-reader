#!/usr/bin/env node

/**
 * Retired (#429). This script read the old local pipeline's `bubbles.json`
 * and looked each speaker's voice up by name in `castlist.json`. Those
 * bubbles carry no `character_id`, so the render chain (`renderVoice` in
 * `~/lib/cast`) cannot key on them, and a name lookup would render and bill
 * characters the database marks "no audio" or removed. It refuses instead.
 * The previous version is in git history.
 *
 * Supported paths: the ingest pipeline's audio step, the review editor's
 * Regenerate, or `pnpm render-bubble` for one bubble.
 */
console.error(
  "generate-audio is retired (#429): its bubbles.json has no character_id for the render chain.\n" +
    "Render audio through the ingest pipeline's audio step, the review editor's Regenerate, " +
    "or `pnpm render-bubble -- --bubble <id> --book <book> --issue <issue>` for one bubble.",
);
process.exit(1);
