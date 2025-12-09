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
}

function useAutoScroll(
  containerRef: React.RefObject<HTMLDivElement>,
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
      className={`flex max-h-[140px] min-h-[72px] flex-col overflow-y-auto rounded-lg border border-neutral-800 bg-black/70 px-3 py-2 ${className}`}
    >
      <div className="mb-1 text-left text-xs tracking-wide text-cyan-300 uppercase">
        {stripAudioTags(bubble.speaker ?? "") || "Narrator"}
      </div>
      <div className="text-left text-base leading-relaxed text-white">
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
