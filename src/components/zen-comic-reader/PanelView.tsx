"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PageDirectedPanel } from "~/types/panels";
import {
  type PanelTransformResult,
  type SpringState,
  createSpringState,
  panelTransform,
  renderedImageRect,
  stepSpring,
} from "./PanelView.transforms";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const fn = () => setReduced(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  return reduced;
}

/**
 * Kindle-style letterbox: dark enough that neighbor panels read as "off",
 * translucent enough that the ~400ms camera spring still glides in context.
 * Single source of truth for all four masking rects below.
 */
const PANEL_DIM_CLASS = "bg-black/85";

export function PanelDimOverlay({
  bbox,
}: {
  bbox: PageDirectedPanel["boundingBox"];
}) {
  const { x, y, w, h } = bbox;
  const topPct = y * 100;
  const leftPct = x * 100;
  const bhPct = h * 100;
  const innerBottom = (y + h) * 100;
  const innerRight = (x + w) * 100;

  return (
    <>
      <div
        className={`pointer-events-auto absolute inset-x-0 top-0 ${PANEL_DIM_CLASS}`}
        style={{ height: `${topPct}%` }}
        aria-hidden
      />
      <div
        className={`pointer-events-auto absolute inset-x-0 bottom-0 ${PANEL_DIM_CLASS}`}
        style={{ top: `${innerBottom}%` }}
        aria-hidden
      />
      <div
        className={`pointer-events-auto absolute left-0 ${PANEL_DIM_CLASS}`}
        style={{
          top: `${topPct}%`,
          width: `${leftPct}%`,
          height: `${bhPct}%`,
        }}
        aria-hidden
      />
      <div
        className={`pointer-events-auto absolute right-0 ${PANEL_DIM_CLASS}`}
        style={{
          top: `${topPct}%`,
          width: `${100 - innerRight}%`,
          height: `${bhPct}%`,
        }}
        aria-hidden
      />
    </>
  );
}

interface PanelViewFrameProps {
  panelViewMode: boolean;
  panels: PageDirectedPanel[];
  panelIndex: number;
  reducedMotion: boolean;
  pageSize: { w: number; h: number };
  /**
   * Camera target: union of the active panel bbox + its bubble rects
   * (see `unionPanelFocusBounds`). Falls back to the raw panel bbox.
   * Kept separate from `panel.boundingBox`, which LayeredPanel and the
   * effects overlay still consume for mask/effect positioning.
   */
  focusBounds?: PageDirectedPanel["boundingBox"] | null;
  children: React.ReactNode;
}

/**
 * Wraps the comic page layer: applies zoom/pan toward the active panel and dims non-active regions.
 */
export function PanelViewFrame({
  panelViewMode,
  panels,
  panelIndex,
  reducedMotion,
  pageSize,
  focusBounds,
  children,
}: PanelViewFrameProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 1, h: 1 });
  const springRef = useRef<SpringState | null>(null);
  const rafRef = useRef<number>(0);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () =>
      setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const activePanel = panels[panelIndex];

  const imageRect = useMemo(
    () => renderedImageRect(containerSize, pageSize),
    [containerSize, pageSize],
  );

  const getTarget = useCallback((): PanelTransformResult => {
    if (
      !panelViewMode ||
      !activePanel ||
      containerSize.w <= 0 ||
      containerSize.h <= 0
    ) {
      return { tx: 0, ty: 0, scale: 1 };
    }
    return panelTransform(
      focusBounds ?? activePanel.boundingBox,
      containerSize,
      imageRect,
    );
  }, [panelViewMode, activePanel, focusBounds, containerSize, imageRect]);

  const applyTransform = useCallback((t: PanelTransformResult) => {
    const el = transformRef.current;
    if (!el) return;
    el.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})`;
    el.style.transformOrigin = "0 0";
  }, []);

  useEffect(() => {
    const target = getTarget();

    if (reducedMotion) {
      applyTransform(target);
      springRef.current = createSpringState(target);
      return;
    }

    if (!springRef.current) {
      springRef.current = createSpringState(target);
      applyTransform(target);
      return;
    }

    // Keep position, reset velocity toward new target
    springRef.current.vTx = 0;
    springRef.current.vTy = 0;
    springRef.current.vScale = 0;

    cancelAnimationFrame(rafRef.current);
    const animate = () => {
      if (!springRef.current) return;
      const { state, atRest } = stepSpring(springRef.current, target);
      springRef.current = state;
      applyTransform(state);
      if (!atRest) rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [getTarget, reducedMotion, applyTransform]);

  // Camera-effect class derived from the active panel's effectTags. Runs
  // forwards-once so the panel settles into a stable pose by the end of
  // its display window. Re-keyed on panel.id so the animation restarts
  // every time we navigate to a new panel.
  const cameraEffectClass =
    !panelViewMode || reducedMotion || !activePanel
      ? ""
      : cameraEffectClassFromTags(activePanel.effectTags);

  // Reserve room for the bottom chrome. Panel mode stacks caption +
  // transport rows in the ControlBar (~280px incl. page padding); regular
  // mode keeps the slimmer 140px reservation.
  const frameSizeClass = panelViewMode
    ? "max-h-[calc(100vh-280px)] max-w-[min(100%,calc((100vh-280px)*0.667))]"
    : "max-h-[calc(100vh-140px)] max-w-[min(100%,calc((100vh-140px)*0.667))]";

  return (
    <div
      ref={viewportRef}
      className={`relative mx-auto aspect-[2/3] w-full overflow-hidden select-none ${frameSizeClass}`}
    >
      <div ref={transformRef} className="relative h-full w-full">
        <div
          key={activePanel?.id ?? "no-panel"}
          className={`relative h-full w-full ${cameraEffectClass}`}
          style={{ transformOrigin: "center center" }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Map active panel effect tags to a camera-effect className. Tags
 * compose: a panel can both push-in AND shake. Tailwind's
 * `animate-[name_dur_easing_count_fill]` arbitrary-value syntax
 * references keyframes defined in globals.css.
 *
 * Multiple animations on a single element merge into one
 * `animation` shorthand list, which works here because each
 * keyframe sets a single transform-prop slice (scale OR translate)
 * — the browser composes them via the `animation-composition` default
 * (`replace`) and we get the last-set value. For simple single-
 * effect panels (the common case) this is fine.
 *
 * If a panel mixes scale + shake we'd want a layered structure, but
 * since panel-direction usually picks one camera tag per panel
 * (Gemini ranks them) we accept the simpler model for v1.
 */
function cameraEffectClassFromTags(tags: string[]): string {
  const classes: string[] = [];
  // Pick the first matching scale/pan tag; pick the first matching shake.
  for (const tag of tags) {
    switch (tag) {
      case "camera_push_in_slow":
        classes.push("animate-[cameraPushInSlow_6s_ease-out_forwards]");
        break;
      case "camera_push_in_fast":
        classes.push("animate-[cameraPushInFast_0.6s_ease-out_forwards]");
        break;
      case "camera_pull_back":
        classes.push("animate-[cameraPullBack_5s_ease-out_forwards]");
        break;
      case "camera_pan_horizontal":
        classes.push(
          "animate-[cameraPanHorizontal_8s_ease-in-out_infinite_alternate]",
        );
        break;
      case "panel_shake_subtle":
        classes.push("animate-[panelShakeSubtle_0.4s_steps(8)_1]");
        break;
      case "panel_shake_hard":
        classes.push("animate-[panelShakeHard_0.6s_steps(12)_1]");
        break;
    }
    if (classes.length > 0) break; // only one camera tag per panel
  }
  return classes.join(" ");
}

interface PanelViewHudProps {
  panelIndex: number;
  panelCount: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  panelAutoPlay: boolean;
  onTogglePanelAutoPlay: () => void;
  announceText: string;
  /** Caption slot (SpeechBox / empty state) — content sits above the transport chrome. */
  children?: React.ReactNode;
}

export function PanelViewHud({
  panelIndex,
  panelCount,
  onClose,
  onPrev,
  onNext,
  panelAutoPlay,
  onTogglePanelAutoPlay,
  announceText,
  children,
}: PanelViewHudProps) {
  const humanIndex = panelCount > 0 ? panelIndex + 1 : 0;
  const progress = panelCount > 0 ? humanIndex / panelCount : 0;

  return (
    <div className="flex w-full min-w-0 flex-col gap-2 px-1">
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announceText}
      </div>

      {/* Row 1: close (left) + panel position (right) */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-2 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Close panel view"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" x2="6" y1="6" y2="18" />
            <line x1="6" x2="18" y1="6" y2="18" />
          </svg>
        </button>

        <span className="text-sm font-semibold text-neutral-200 tabular-nums">
          Panel {humanIndex} of {panelCount}
        </span>
      </div>

      {/* Caption is content; it sits above the transport buttons. */}
      {children}

      {/* Row 2: transport — ghost prev / hero play / ghost next */}
      <div className="flex items-center justify-center gap-6">
        <button
          type="button"
          onClick={onPrev}
          disabled={panelIndex <= 0}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/15 disabled:opacity-40"
          aria-label="Previous panel"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>

        <button
          type="button"
          onClick={onTogglePanelAutoPlay}
          className={`flex h-11 min-w-11 items-center justify-center gap-2 rounded-full transition-colors ${
            panelAutoPlay
              ? "bg-cyan-600 px-3 text-white hover:bg-cyan-500"
              : "bg-white/10 px-5 text-white hover:bg-white/15"
          }`}
          aria-label={
            panelAutoPlay ? "Pause reading aloud" : "Read panels aloud"
          }
          aria-pressed={panelAutoPlay}
        >
          {panelAutoPlay ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M8 5.14v13.72L19 12 8 5.14z" />
              </svg>
              <span className="text-sm font-semibold">Read to me</span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={onNext}
          disabled={panelIndex >= panelCount - 1}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/15 disabled:opacity-40"
          aria-label="Next panel"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>

      {/* Single progress story in panel mode (page tick hidden in ControlBar). */}
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-white/10"
        aria-hidden
      >
        <div
          className="h-full rounded-full bg-cyan-500/80 transition-[width] duration-300 ease-out"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}
