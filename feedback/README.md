# Feedback

Where you (the user) drop bugs / tweaks / polish notes from real-device testing. Claude reads these natively without MCP — just markdown + image refs in the repo.

## How to use

1. Take an iOS screenshot (Side button + Volume up).
2. Tap the thumbnail → use **Markup** to circle / arrow / annotate. Save.
3. AirDrop or copy the annotated image into `feedback/screenshots/`. Name it like `2026-04-30-bubble-dots.png`.
4. Add an entry in the dated session file (e.g. `feedback/2026-04-30.md`) using the template below. Reference the image inline.
5. When ready, ping Claude with "go through `feedback/2026-04-30.md` and fix what you can." I'll triage, ask any clarifying questions, and ship PRs.

## Template

Each session lives in its own `YYYY-MM-DD.md` file. Issues are numbered for easy reference in conversation ("the issue 3 fix").

````md
# Testing session — 2026-04-30

Device: iPhone 15, Safari iOS 18.x
Build: <commit sha or PR link>

## 1. <Short title>
**Type**: bug | tweak | feature | question
**Severity**: blocker | major | minor | nit
**Location**: `/book/tmnt-mmpr-iii/issue-1/3` panel-view auto-play

![](./screenshots/2026-04-30-bubble-dots.png)

What's happening / what I expected:
- Free-form text. Bullets are nice for separate observations on the same screenshot.
- Don't worry about being terse — more context = fewer back-and-forth questions.

Suggestion (optional):
- "Maybe bump the dot border to 3px" / "I'd rather this be a setting" / etc.

---

## 2. <next issue>
…
````

## Status workflow (lightweight)

I'll mark issues inline as I work through them, no separate tracker:

- Untouched: just the issue text.
- Picked up: I'll add `**Status**: in PR #NN` near the top.
- Done: `**Status**: ✅ shipped in #NN` after merge.
- Won't fix / out-of-scope: `**Status**: ❌ deferred — <reason>` so we don't relitigate it.

Once a session file is fully resolved you can delete the screenshot files and add a note "✓ all resolved" — or keep it around as documentation.

## When to graduate beyond this

- More than ~30 open items at a time → switch to Linear (MCP integration is solid, it'll handle status better).
- Polishing a specific feature that has its own design intent → drop a Figma file and we'll annotate there.
- Anything that needs cross-team visibility / non-technical readers → GitHub Issues.

For solo testing-and-iterating, plain markdown wins.
