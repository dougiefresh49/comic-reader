"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Bubble, CharacterAlignment } from "~/types";
import {
  buildWordTimings,
  stripAudioTags,
  tokenizeCleanText,
  type WordTiming,
} from "./helpers";

type Alignment = CharacterAlignment | null | undefined;

interface Props {
  bubble: Bubble | null;
  alignment: Alignment;
  activeWordIndex: number | null;
  className?: string;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
}

function useAutoScroll(
  containerRef: React.RefObject<HTMLDivElement | null>,
  wordRefs: React.MutableRefObject<Record<number, HTMLSpanElement | null>>,
  activeIndex: number | null,
) {
  useEffect(() => {
    if (activeIndex === null) return;
    const container = containerRef.current;
    const wordEl = wordRefs.current[activeIndex];
    if (!container || !wordEl) return;

    const containerRect = container.getBoundingClientRect();
    const wordRect = wordEl.getBoundingClientRect();

    const isAbove = wordRect.top < containerRect.top;
    const isBelow = wordRect.bottom > containerRect.bottom;

    if (isAbove || isBelow) {
      wordEl.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "smooth",
      });
    }
  }, [activeIndex, containerRef, wordRefs]);
}

export function SpeechBox({
  bubble,
  alignment,
  activeWordIndex,
  className = "",
  isPlaying = false,
  onTogglePlay,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wordRefs = useRef<Record<number, HTMLSpanElement | null>>({});

  const { tokens, wordTimings } = useMemo(() => {
    if (!bubble) return { tokens: [], wordTimings: [] as WordTiming[] };
    const rawText = bubble.textWithCues ?? bubble.ocr_text ?? "";
    const clean = stripAudioTags(rawText);
    const timings = buildWordTimings(alignment ?? null);
    const toks = tokenizeCleanText(clean);
    return { tokens: toks, wordTimings: timings };
  }, [alignment, bubble]);

  useAutoScroll(containerRef, wordRefs, activeWordIndex);

  if (!bubble) {
    return (
      <div
        className={`flex h-full items-center justify-center text-sm text-neutral-500 italic ${className}`}
      >
        Tap a bubble...
      </div>
    );
  }

  let wordCursor = 0;

  return (
    <div
      ref={containerRef}
      className={`flex h-full min-h-[72px] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-black/70 px-3 py-2 ${className}`}
    >
      <div className="mb-1 flex items-center justify-between text-left text-xs tracking-wide text-cyan-300 uppercase">
        <span>{stripAudioTags(bubble.speaker ?? "") || "Narrator"}</span>
        {onTogglePlay ? (
          <button
            onClick={onTogglePlay}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
            aria-label={isPlaying ? "Pause audio" : "Play audio"}
          >
            {isPlaying ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
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
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M8 5.14v13.72L19 12 8 5.14z" />
              </svg>
            )}
          </button>
        ) : null}
      </div>
      <div className="flex-1 overflow-y-auto text-left text-base leading-relaxed text-white">
        {tokens.map((token, idx) => {
          if (token.isWord) {
            const wordTiming = wordTimings[wordCursor];
            const highlight =
              wordTiming?.index !== undefined &&
              activeWordIndex === wordTiming.index;
            const refIndex = wordTiming?.index ?? wordCursor;
            const element = (
              <span
                key={`${idx}-${token.text}`}
                ref={(el) => {
                  if (typeof refIndex === "number") {
                    wordRefs.current[refIndex] = el;
                  }
                }}
                className={`inline-block rounded-sm px-0.5 transition-colors ${
                  highlight ? "bg-cyan-500/25 text-cyan-100" : "text-white"
                }`}
                style={{ scrollMargin: "12px" }}
              >
                {token.text}
              </span>
            );
            wordCursor += 1;
            return element;
          }
          return (
            <span
              key={`${idx}-${token.text}`}
              className="inline-block px-0.5 text-white/80"
            >
              {token.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default SpeechBox;
