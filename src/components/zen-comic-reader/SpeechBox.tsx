"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  useActiveWordIndex,
  type WordHighlightStore,
} from "~/hooks/useWordHighlight";
import type { WordTiming } from "./text-utils";

interface SpeechBoxProps {
  /** The bubble this caption shows; the word state applies only while it plays. */
  bubbleId: string;
  speaker?: string | null;
  text: string;
  words: WordTiming[];
  wordHighlight: WordHighlightStore;
  /** False hides the sliding word pill; the text still fades ahead of the word. */
  showWordPill?: boolean;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  /** False: the bubble has no clip, so a "No voice yet" note replaces Play. */
  voiced?: boolean;
}

export function SpeechBox({
  bubbleId,
  speaker,
  text,
  words,
  wordHighlight,
  showWordPill = true,
  isPlaying,
  onTogglePlay,
  voiced = true,
}: SpeechBoxProps) {
  // Subscribed here, not in the reader, so a word change re-renders only
  // this caption (#87).
  const activeWordIndex = useActiveWordIndex(wordHighlight, bubbleId);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLSpanElement | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  // Sliding highlight: one absolutely-positioned pill glides over the active
  // word (transform/width transitions) instead of restyling word spans. The
  // old per-word `px-1` padding reflowed the whole line on every word change.
  useEffect(() => {
    const highlight = highlightRef.current;
    const target = activeRef.current;
    if (!highlight) return;
    if (!target || !showWordPill) {
      highlight.style.opacity = "0";
      return;
    }
    const padX = 3;
    const padY = 1;
    highlight.style.opacity = "1";
    highlight.style.transform = `translate(${target.offsetLeft - padX}px, ${target.offsetTop - padY}px)`;
    highlight.style.width = `${target.offsetWidth + padX * 2}px`;
    highlight.style.height = `${target.offsetHeight + padY * 2}px`;
  }, [activeWordIndex, words, text, showWordPill]);

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
      // The caption container is overflow-y-auto only; an `inline: "center"`
      // here would walk up the DOM and scroll the page horizontally,
      // clipping the caption mid-word. Stick to vertical scroll-to-line.
      target.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [activeWordIndex]);

  const fragments = useMemo(() => {
    if (!words.length) return [text];

    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    // While a word is active, text after it is faint so a kid can find their
    // place. Color only: weight or padding per word would reflow the line.
    const isFuture = (idx: number) =>
      activeWordIndex !== null && idx > activeWordIndex;

    words.forEach((word, idx) => {
      if (cursor < word.cleanTextStart) {
        nodes.push(
          <span
            key={`gap-${idx}`}
            className={isFuture(idx) ? "text-white/50" : "text-white/80"}
          >
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
          className={isFuture(idx) ? "text-white/50" : "text-white"}
        >
          {content}
        </span>,
      );

      cursor = word.cleanTextEnd;
    });

    if (cursor < text.length) {
      nodes.push(
        <span
          key="tail"
          className={isFuture(words.length) ? "text-white/50" : "text-white/80"}
        >
          {text.slice(cursor)}
        </span>,
      );
    }

    return nodes;
  }, [words, text, activeWordIndex]);

  return (
    <div className="relative flex min-h-[78px] w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-black/70 p-3 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
      <div className="mb-1 flex min-h-6 items-center justify-between">
        {speaker && (
          <span className="text-xs font-semibold tracking-[0.08em] text-cyan-300 uppercase">
            {speaker}
          </span>
        )}
        {!voiced ? (
          <span className="ml-auto text-xs text-white/50">No voice yet</span>
        ) : onTogglePlay ? (
          <button
            onClick={onTogglePlay}
            className="ml-auto flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
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
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M8 5.14v13.72L19 12 8 5.14z" />
              </svg>
            )}
          </button>
        ) : null}
      </div>
      <div
        ref={containerRef}
        className="max-h-24 overflow-y-auto text-base leading-relaxed text-white/90"
      >
        {/* key={text} remounts the pill per bubble so it never slides between captions */}
        <div key={text} className="relative">
          {fragments}
          <div
            ref={highlightRef}
            aria-hidden="true"
            className="pointer-events-none absolute top-0 left-0 rounded-md bg-cyan-400/25 opacity-0 transition-[transform,width,height,opacity] duration-150 ease-out"
          />
        </div>
      </div>
    </div>
  );
}
