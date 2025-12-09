"use client";

import { useEffect, useMemo, useRef } from "react";
import type { WordTiming } from "./text-utils";

interface SpeechBoxProps {
  speaker?: string | null;
  text: string;
  words: WordTiming[];
  activeWordIndex: number | null;
}

export function SpeechBox({
  speaker,
  text,
  words,
  activeWordIndex,
}: SpeechBoxProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const target = activeRef.current;
    if (!container || !target) return;

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    const isVisible =
      targetRect.top >= containerRect.top &&
      targetRect.bottom <= containerRect.bottom &&
      targetRect.left >= containerRect.left &&
      targetRect.right <= containerRect.right;

    if (!isVisible) {
      target.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    }
  }, [activeWordIndex]);

  const fragments = useMemo(() => {
    if (!words.length) return [text];

    const nodes: React.ReactNode[] = [];
    let cursor = 0;

    words.forEach((word, idx) => {
      if (cursor < word.cleanTextStart) {
        nodes.push(
          <span key={`gap-${idx}`} className="text-white/80">
            {text.slice(cursor, word.cleanTextStart)}
          </span>,
        );
      }

      const content = text.slice(word.cleanTextStart, word.cleanTextEnd);
      const isActive = activeWordIndex === idx;

      nodes.push(
        <span
          key={`word-${idx}`}
          ref={isActive ? activeRef : null}
          className={
            isActive
              ? "rounded-md bg-cyan-500/20 px-1 text-white shadow-[0_0_12px_rgba(34,211,238,0.6)]"
              : "text-white"
          }
        >
          {content}
        </span>,
      );

      cursor = word.cleanTextEnd;
    });

    if (cursor < text.length) {
      nodes.push(
        <span key="tail" className="text-white/80">
          {text.slice(cursor)}
        </span>,
      );
    }

    return nodes;
  }, [words, text, activeWordIndex]);

  return (
    <div className="relative flex min-h-[78px] w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-black/70 px-4 py-3 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
      <div className="mb-1 text-xs font-semibold tracking-[0.08em] text-cyan-300 uppercase">
        {speaker?.trim() || "Narrator"}
      </div>
      <div
        ref={containerRef}
        className="max-h-24 overflow-y-auto text-base leading-relaxed text-white/90"
      >
        {fragments}
      </div>
    </div>
  );
}
