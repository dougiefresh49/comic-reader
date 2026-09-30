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
  PANEL_VIEW_MARGIN,
  type PanelTransformResult,
  type SpringState,
  createSpringState,
  maxPanelScale,
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

/** Four rects covering everything in the containing block outside x/y/w/h (CSS lengths). */
function DimRects({
  x,
  y,
  w,
  h,
}: {
  x: string;
  y: string;
  w: string;
  h: string;
}) {
  return (
    <>
      <div
        className={`pointer-events-auto absolute inset-x-0 top-0 ${PANEL_DIM_CLASS}`}
        style={{
          height: y,
        }}
        aria-hidden
      />
      <div
        className={`pointer-events-auto absolute inset-x-0 bottom-0 ${PANEL_DIM_CLASS}`}
        style={{
          top: `calc(${y} + ${h})`,
        }}
        aria-hidden
      />
      <div
        className={`pointer-events-auto absolute left-0 ${PANEL_DIM_CLASS}`}
        style={{
          top: y,
          width: x,
          height: h,
        }}
        aria-hidden
      />
      <div
        className={`pointer-events-auto absolute right-0 ${PANEL_DIM_CLASS}`}
        style={{
          top: y,
          left: `calc(${x} + ${w})`,
          height: h,
        }}
        aria-hidden
      />
    </>
  );
}

/** Page-space dim, for a page plane child. It stops at the page edges. */
export function PanelDimOverlay({
  bbox,
}: {
  bbox: PageDirectedPanel["boundingBox"];
}) {
  return (
    <DimRects
      x={`${bbox.x * 100}%`}
      y={`${bbox.y * 100}%`}
      w={`${bbox.w * 100}%`}
      h={`${bbox.h * 100}%`}
    />
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
  /**
   * Dim everything outside the focus rect in viewport space, letterbox
   * strips beyond the page edges included. Callers that render a
   * page-space `PanelDimOverlay` child leave this off.
   */
  dimOutsideFocus?: boolean;
  /** Animate the page plane from panel camera tags. Reader callers disable this. */
  cameraEffects?: boolean;
  children: React.ReactNode;
}

/**
 * Wraps the comic page layer: applies zoom/pan toward the active panel and dims non-active regions.
 * `children` render inside the page plane (`data-page-plane`), a box at the
 * rendered image rect, so they position in page percent.
 */
export function PanelViewFrame({
  panelViewMode,
  panels,
  panelIndex,
  reducedMotion,
  pageSize,
  focusBounds,
  dimOutsideFocus = false,
  cameraEffects = true,
  children,
}: PanelViewFrameProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 1, h: 1 });
  const [devicePixelRatio, setDevicePixelRatio] = useState(1);
  const springRef = useRef<SpringState | null>(null);
  const rafRef = useRef<number>(0);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      setContainerSize({ w: el.clientWidth, h: el.clientHeight });
      setDevicePixelRatio(window.devicePixelRatio || 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const activePanel = panels[panelIndex];
  const focusRect = focusBounds ?? activePanel?.boundingBox;

  const imageRect = useMemo(
    () => renderedImageRect(containerSize, pageSize),
    [containerSize, pageSize],
  );

  const getTarget = useCallback((): PanelTransformResult => {
    if (
      !panelViewMode ||
      !focusRect ||
      containerSize.w <= 0 ||
      containerSize.h <= 0
    ) {
      return { tx: 0, ty: 0, scale: 1 };
    }
    return panelTransform(
      focusRect,
      containerSize,
      imageRect,
      PANEL_VIEW_MARGIN,
      maxPanelScale(imageRect.w, pageSize.w, devicePixelRatio),
    );
  }, [
    panelViewMode,
    focusRect,
    containerSize,
    imageRect,
    pageSize.w,
    devicePixelRatio,
  ]);

  const applyTransform = useCallback(
    (t: PanelTransformResult) => {
      const el = transformRef.current;
      if (!el) return;
      el.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})`;
      el.style.transformOrigin = "0 0";

      const viewport = viewportRef.current;
      if (!viewport || !focusRect) return;
      viewport.style.setProperty(
        "--focus-x",
        `${t.tx + (imageRect.x + focusRect.x * imageRect.w) * t.scale}px`,
      );
      viewport.style.setProperty(
        "--focus-y",
        `${t.ty + (imageRect.y + focusRect.y * imageRect.h) * t.scale}px`,
      );
      viewport.style.setProperty(
        "--focus-w",
        `${focusRect.w * imageRect.w * t.scale}px`,
      );
      viewport.style.setProperty(
        "--focus-h",
        `${focusRect.h * imageRect.h * t.scale}px`,
      );
    },
    [focusRect, imageRect],
  );

  useLayoutEffect(() => {
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
    // Reproject the current focus rect before paint when the page plane resizes.
    applyTransform(springRef.current);

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
  }, [getTarget, reducedMotion, applyTransform, activePanel?.id]);

  const cameraEffectClass =
    !cameraEffects || !panelViewMode || reducedMotion || !activePanel
      ? ""
      : cameraEffectClassFromTags(activePanel.effectTags);

  // Panel mode fills the measured reader area. Page mode keeps the 2:3
  // frame with 140px reserved for the bottom chrome.
  const frameSizeClass = panelViewMode
    ? "h-full w-full"
    : "mx-auto aspect-[2/3] w-full max-h-[calc(100vh-140px)] max-w-[min(100%,calc((100vh-140px)*0.667))]";

  return (
    <div
      ref={viewportRef}
      className={`relative overflow-hidden select-none ${frameSizeClass}`}
    >
      <div ref={transformRef} className="relative h-full w-full">
        <div
          key={activePanel?.id ?? "no-panel"}
          className={`relative h-full w-full ${cameraEffectClass}`}
          style={{ transformOrigin: "center center" }}
        >
          {/* Page plane: sized to the page's own aspect so object-contain
              never letterboxes and every page-% overlay in `children`
              lands on the art. Full frame until the natural size loads. */}
          <div
            data-page-plane
            className="absolute"
            style={{
              left: imageRect.x,
              top: imageRect.y,
              width: imageRect.w,
              height: imageRect.h,
            }}
          >
            {children}
          </div>
        </div>
      </div>
      {dimOutsideFocus && panelViewMode && focusRect ? (
        <DimRects
          x="var(--focus-x, 0px)"
          y="var(--focus-y, 0px)"
          w="var(--focus-w, 0px)"
          h="var(--focus-h, 0px)"
        />
      ) : null}
    </div>
  );
}

/** Map the first supported camera tag to its existing page-plane animation. */
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
  /** Caption slot (SpeechBox / empty state) — content sits below the chrome row, above the progress bar. */
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
    <div className="flex w-full min-w-0 flex-col gap-2">
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announceText}
      </div>

      {/* Single chrome row: close/exit (left) | transport (centered) | panel position (right).
          1fr side tracks keep the transport optically centered. */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <button
          type="button"
          onClick={onClose}
          className="justify-self-start rounded-full p-2 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
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

        {/* Transport — ghost prev / hero play / ghost next */}
        <div className="flex items-center justify-center gap-2">
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
                : "bg-white/10 px-3 text-white hover:bg-white/15 min-[360px]:px-4"
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
                {/* Responsive label: icon-only < 360px, "Read" < sm, "Read to me" on sm+ */}
                <span className="hidden text-sm font-semibold min-[360px]:inline sm:hidden">
                  Read
                </span>
                <span className="hidden text-sm font-semibold sm:inline">
                  Read to me
                </span>
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

        <span className="justify-self-end text-sm font-semibold whitespace-nowrap text-neutral-200 tabular-nums">
          Panel {humanIndex} of {panelCount}
        </span>
      </div>

      {/* Caption is content; it sits below the chrome row, stretched to a
          slim gutter (ControlBar px-4 minus 4px → 12px each side). */}
      <div className="-mx-1 min-w-0">{children}</div>

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
