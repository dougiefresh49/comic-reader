# Phase 5 — ZenComicReader Refactor

## Goal
Break up the 600+ line `ZenComicReader.tsx` monolith into focused custom hooks so the component is readable, debuggable, and ready for the "karaoke word highlight" feature to be added cleanly.

## Why
George's direct feedback: extract into React hooks so things are only exposed when needed. If something breaks, you shouldn't be digging through 500+ lines. Target: root component under 200 lines.

---

## Current State
`src/components/ZenComicReader.tsx` — ~600+ lines containing:
- Page navigation state + swipe gesture detection
- Audio playback management (single-audio enforcement)
- Autoplay logic (advance to next bubble on audio end)
- Word-level timestamp sync (karaoke highlight)
- Pinch/zoom + pan gesture handling
- Settings persistence (localStorage)
- All JSX rendering

---

## Target State

### Hooks to Extract

| Hook | File | Responsibility |
|------|------|----------------|
| `usePageNavigation` | `src/hooks/usePageNavigation.ts` | Current page index, prev/next, swipe detection (50px threshold), edge tap zones |
| `useAudioPlayback` | `src/hooks/useAudioPlayback.ts` | Single-audio-at-a-time ref, play/pause/stop, `onEnded` callback |
| `useAutoPlay` | `src/hooks/useAutoPlay.ts` | After audio ends, wait X seconds then trigger next bubble; toggle on/off |
| `useWordHighlight` | `src/hooks/useWordHighlight.ts` | `onTimeUpdate` listener, match current time to ElevenLabs word alignment timestamps, return active word index |
| `usePinchZoom` | `src/hooks/usePinchZoom.ts` | Touch event handling for pinch zoom (1x–3.5x clamp) and pan; reset on page change |
| `useSettings` | `src/hooks/useSettings.ts` | localStorage read/write for autoPlayEnabled, zoom level, any other persisted prefs |

### Root Component After Refactor
```tsx
export function ZenComicReader({ pages, bookId, issueId }: Props) {
  const { currentPage, goNext, goPrev, goTo } = usePageNavigation(pages);
  const { playBubble, stopAll, isPlaying } = useAudioPlayback();
  const { autoPlay, toggleAutoPlay } = useAutoPlay(pages[currentPage]?.bubbles, playBubble);
  const { activeWordIndex } = useWordHighlight(/* audioRef, timestamps */);
  const { scale, panX, panY, handlers } = usePinchZoom();
  const { settings, updateSetting } = useSettings();

  return (
    <div className="...">
      <ComicPage page={pages[currentPage]} scale={scale} panX={panX} panY={panY} {...handlers} />
      <BubbleOverlay bubbles={pages[currentPage]?.bubbles} activeWordIndex={activeWordIndex} onTap={playBubble} />
      <ControlBar onPrev={goPrev} onNext={goNext} autoPlay={autoPlay} onToggleAutoPlay={toggleAutoPlay} />
    </div>
  );
}
```

---

## Implementation Steps

1. Read `src/components/ZenComicReader.tsx` in full to map current state/logic
2. Create `src/hooks/useSettings.ts` (simplest — start here)
3. Create `src/hooks/usePinchZoom.ts`
4. Create `src/hooks/usePageNavigation.ts`
5. Create `src/hooks/useAudioPlayback.ts`
6. Create `src/hooks/useAutoPlay.ts`
7. Create `src/hooks/useWordHighlight.ts`
8. Rewrite `ZenComicReader.tsx` to use all hooks, target <200 lines
9. Verify no regression in existing reader functionality

## Gemini Models
This phase is a pure frontend refactor — no Gemini API calls. Do not add any.

## Key Types (from `src/types/comic.ts`)
Check this file before writing hooks — `Bubble`, `CharacterAlignment`, and other types needed by hooks are defined there.

## Verification
```bash
pnpm dev
```
- Open existing TMNT x MMPR issue in browser
- Verify: page navigation (swipe + arrows), bubble tap plays audio, autoplay advances, word highlight syncs, pinch-zoom works on mobile viewport
- `pnpm typecheck` — no errors
- `pnpm lint` — no warnings
