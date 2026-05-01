# Reader chrome redesign — Kindle-inspired cleanup

**Status**: pending — needs review before build

## Problem

The reader's bottom control bar has accumulated controls as features
landed: page selector, settings, panel-view toggle, prev/next page,
auto-play toggle, speech-text display, progress indicator, and now
volume + reading-speed controls inside the settings sheet. The user's
testing-session feedback called it "a bit of a mess."

## What the Kindle reference shows

(Screens in `feedback/screenshots/kindle/`.)

- **Top bar** holds *navigation*: back, table of contents, page-format
  ("Aa" sheet) toggle, and a more-actions overflow.
- **Bottom bar** holds *progress*: a thin track + "Location N of M •
  X%" label. That's it.
- **Reading panel** itself is uncluttered. Tap once to dismiss chrome,
  tap again to bring it back. Chrome auto-fades after a few seconds
  of inactivity.
- **Guided View entry** is via the page-format ("Aa") sheet, not a
  button squeezed into the main bar.
- **Bubbles outside panel rect** are sometimes cut off — Kindle crops
  exactly to the panel bbox, not padded. They accept the tradeoff for
  the more cinematic feel.

## Goal

The reader feels uncluttered by default, with chrome surfaces that
auto-hide and concentrate related controls into focused sheets.

## Layout

```
┌─────────────────────────────────────────┐
│ Top bar (auto-hide)                     │
│  ← back   ☰ pages   ⚙ settings   Aa     │
├─────────────────────────────────────────┤
│                                         │
│                                         │
│             Comic page                  │
│             (or panel view)             │
│                                         │
│                                         │
├─────────────────────────────────────────┤
│ Speech / progress (always)              │
│  ▶ "Speaker name: dialogue text…"       │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
└─────────────────────────────────────────┘
```

### Top bar — auto-hiding navigation chrome

Visibility:

- Visible by default for 3s on page mount.
- Hides after 3s of no interaction (no tap, swipe, or panel-nav).
- Re-shows on any tap that doesn't land on a bubble.
- Always visible while the settings or page-list sheet is open.

Contents (left-to-right):

- **← Back** — to book page.
- **☰ Pages** — opens the existing page selector sheet.
- **⚙ Settings** — opens the settings sheet (audio + reading
  preferences).
- **Aa** — opens a small "view" sheet: panel view on/off, motion
  intensity, reduce-motion respect. (Yes, this overlaps with settings;
  it's the Kindle convention and we keep one-tap access to the
  reading-mode controls separately from audio controls.)

### Bottom bar — speech + progress

Always visible. Two zones:

- **Speech text** (existing `SpeechBox`) — speaker name + dialogue
  with karaoke highlighting.
- **Page progress** — thin 2px bar showing position within issue.
  Tappable to expand into a Kindle-style "Location N of M • X%"
  label. Doubles as a swipe affordance for page nav.

### Settings sheet — three sections

Currently the settings sheet has volume sliders + reading-speed +
auto-play scattered together. Reorganize into:

1. **Audio**
   - Reading speed slider (0.75–2x)
   - Volume sliders: dialogue / music / sfx / ambience (existing)
   - Reset to defaults
2. **Reading**
   - Auto-advance on/off (existing auto-play)
   - Default to panel view (existing — controls
     `panelViewPreferred`)
   - Motion intensity: Off / Reduced / Full
3. **About** (collapsed by default)
   - "Available offline" indicator
   - Version

### "Aa" view sheet — quick controls

Smaller, contextual sheet that lives in the top-right.

- **View**: Whole page / Panel by panel (radio)
- **Motion**: Off / Reduced / Full (radio)

These also exist in the main settings sheet under "Reading"; the Aa
sheet is just a one-tap shortcut for the most-changed controls. Same
state, two surfaces.

## Components

New / changed:

- `src/components/zen-comic-reader/TopBar.tsx` (new) — the
  auto-hiding top chrome.
- `src/components/zen-comic-reader/AaSheet.tsx` (new) — the
  view-mode quick sheet.
- `src/components/zen-comic-reader/SettingsSheet.tsx` (changed) —
  reorganized into Audio / Reading / About sections.
- `src/components/zen-comic-reader/ControlBar.tsx` (changed) —
  bottom bar collapses to speech + progress only; loses the buttons
  that move to top bar.
- `src/components/ZenComicReader.tsx` (changed) — wire up auto-hide
  state (probably a custom `useChromeAutoHide` hook).
- `src/hooks/useChromeAutoHide.ts` (new) — 3s timer, tap detection,
  visibility state.

## Out of scope for this redesign

- Animated panel transitions (the smooth Kindle slide). Worth doing
  separately — probably its own short PR using a spring curve.
- Tighter panel cropping. Tradeoff is material (loses bubbles outside
  the panel rect on some pages); needs a separate decision.
- Reverse-engineering the Kindle binary. Not necessary; CSS can match
  the feel.

## Phasing

1. **Top bar + auto-hide** (½ day). New component, hook, wire-up.
2. **Settings sheet reorg** (½ day). Reorganize sections, no new
   features.
3. **Aa sheet** (¼ day). Small sheet component, shares state with
   settings.
4. **Bottom bar slim-down** (¼ day). Remove buttons, keep speech +
   progress.

Total: ~1.5 days. Each phase ships independently if we want to land
incrementally. Suggest landing 1+4 together (visible chrome change),
then 2+3 (settings polish).

## Risks

- **Auto-hide and discoverability.** First-time users won't know
  there's chrome. Mitigation: the top bar stays visible for 3s on
  first mount, longer on first session (track via localStorage flag).
- **Tap to bring back chrome conflicts with bubble taps.** Bubble
  taps are absorbed before the document-level handler; tap-anywhere-
  else triggers chrome show. Tested approach in similar readers.
- **Settings sheet sections feel "deep."** Three accordion sections
  is one more level of nesting than current. Mitigation: keep
  sections expanded by default on first open; persist last-opened
  section.
