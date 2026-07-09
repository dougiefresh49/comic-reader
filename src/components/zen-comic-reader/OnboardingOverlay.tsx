"use client";

import { useCallback, useEffect, useState } from "react";

const ONBOARDING_KEY = "comic-reader.onboarding.v1";

/**
 * First-run walkthrough gate. Reads the localStorage flag after mount
 * (SSR-safe, no hydration mismatch) and exposes a dismiss that persists it.
 * Finish and Skip both set the flag — the walkthrough never shows again.
 */
export function useOnboarding() {
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(ONBOARDING_KEY) === null) {
        setIsOnboardingOpen(true);
      }
    } catch {
      // Storage unavailable (private mode, etc.) — skip the walkthrough.
    }
  }, []);

  const dismissOnboarding = useCallback(() => {
    try {
      window.localStorage.setItem(ONBOARDING_KEY, "done");
    } catch {
      // Best effort — still close for this session.
    }
    setIsOnboardingOpen(false);
  }, []);

  return { isOnboardingOpen, dismissOnboarding };
}

interface OnboardingStep {
  title: string;
  body: string;
  icon: React.ReactNode;
}

const STEPS: OnboardingStep[] = [
  {
    title: "Tap a bubble",
    body: "Tap any speech bubble to hear the character talk. The words light up while they speak!",
    icon: <IconTapBubble />,
  },
  {
    title: "Turn the page",
    body: "Swipe left or right to turn the page. On a computer, the arrow keys work too.",
    icon: <IconSwipeArrows />,
  },
  {
    title: "Find the menus",
    body: "Tap an empty spot on the page to show the menus. Pages and Settings live at the top.",
    icon: <IconGear />,
  },
  {
    title: "Hear it again",
    body: "Press the play button on the card at the bottom to hear the last bubble read again.",
    icon: <IconPlayCircle />,
  },
];

interface OnboardingOverlayProps {
  /** Called on Finish or Skip — the caller persists the flag and unmounts. */
  onDismiss: () => void;
}

export function OnboardingOverlay({ onDismiss }: OnboardingOverlayProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const isLastStep = stepIndex === STEPS.length - 1;

  const goNext = useCallback(() => {
    setStepIndex((i) => {
      if (i >= STEPS.length - 1) {
        onDismiss();
        return i;
      }
      return i + 1;
    });
  }, [onDismiss]);

  const goBack = useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1));
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      } else if (e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss, goNext, goBack]);

  const step = STEPS[stepIndex];
  if (!step) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="How to use the reader"
    >
      <div className="flex w-full max-w-sm flex-col rounded-2xl border border-white/10 bg-neutral-950/95 px-6 pt-6 pb-5 shadow-[0_10px_40px_rgba(0,0,0,0.6)]">
        <div className="mb-4 flex items-center justify-center text-cyan-300">
          {step.icon}
        </div>

        <h2 className="mb-1 text-center text-lg font-semibold text-white">
          {step.title}
        </h2>
        <p className="mb-5 min-h-[3.5rem] text-center text-sm leading-relaxed text-neutral-300">
          {step.body}
        </p>

        <div className="mb-5 flex items-center justify-center gap-2">
          {STEPS.map((s, i) => (
            <span
              key={s.title}
              className={`h-2 w-2 rounded-full transition-colors ${
                i === stepIndex ? "bg-cyan-400" : "bg-white/20"
              }`}
            />
          ))}
        </div>

        <div className="flex items-center gap-2">
          {stepIndex > 0 ? (
            <button
              type="button"
              onClick={goBack}
              className="flex h-12 flex-1 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-sm font-semibold text-neutral-200 transition-colors hover:bg-white/10"
            >
              Back
            </button>
          ) : null}
          <button
            type="button"
            onClick={goNext}
            autoFocus
            className="flex h-12 flex-1 items-center justify-center rounded-xl bg-cyan-500 text-sm font-semibold text-neutral-950 transition-colors hover:bg-cyan-400"
          >
            {isLastStep ? "Start reading" : "Next"}
          </button>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className="mt-3 flex h-10 items-center justify-center rounded-lg text-xs font-semibold tracking-[0.08em] text-neutral-500 uppercase transition-colors hover:text-neutral-300"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

const svgProps = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 44,
  height: 44,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function IconTapBubble() {
  return (
    <svg {...svgProps}>
      {/* pointer arrow tapping, with impact ticks */}
      <path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z" />
      <path d="M7.2 2.2 8 5.1" />
      <path d="m5.1 8-2.9-.8" />
      <path d="M14 4.1 12 6" />
      <path d="m6 12-1.9 2" />
    </svg>
  );
}

function IconSwipeArrows() {
  return (
    <svg {...svgProps}>
      <path d="M8 12H2" />
      <path d="m5 9-3 3 3 3" />
      <path d="M16 12h6" />
      <path d="m19 9 3 3-3 3" />
      <rect x="10.5" y="9" width="3" height="6" rx="1.5" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg {...svgProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 3.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8 3.6 1.65 1.65 0 0 0 9.51 2.1H9.6a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 3.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.29.63.95 1 1.66 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconPlayCircle() {
  return (
    <svg {...svgProps}>
      <circle cx="12" cy="12" r="10" />
      <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
    </svg>
  );
}
