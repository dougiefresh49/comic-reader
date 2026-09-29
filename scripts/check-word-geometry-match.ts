/**
 * Fixture acceptance for the letter-level timing-to-box matcher (#62). Runs
 * every `fixtures/word-geometry/*.json`, prints per-bubble coverage and the
 * total "timing words boxed X/Y" over the real bubbles, and exits non-zero
 * when any expectation fails. No DB and no network calls.
 *
 * Real fixtures carry the stored `audio_timestamps.alignment`. Synthetic
 * fixtures (`"synthetic": true`) may omit it; the checker then times each
 * character of `text_with_cues` evenly so `buildWordTimings` still builds
 * the timings.
 *
 * Usage: pnpm exec tsx scripts/check-word-geometry-match.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildWordTimings } from "~/components/zen-comic-reader/text-utils";
import { alignTimingsToGeometry } from "~/lib/word-geometry-match";
import type { CharacterAlignment } from "~/types";
import type { Box, TextGeometry } from "~/types/text-geometry";

type Expect = {
  minCoverage?: number;
  coverage?: number;
  letteredWordCount?: number;
  boxesByTimingIndex?: Box[][];
};

type Case = {
  bubbleId: string;
  text_with_cues: string | null;
  alignment?: CharacterAlignment | null;
  geometry: TextGeometry | null;
  expect: Expect;
};

type Fixture = { synthetic?: boolean; bubbles: Case[] };

const dir = resolve("fixtures/word-geometry");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();

// #62 acceptance: at least 170 real timing words boxed. Not every word must
// be: a TTS-only insertion legitimately gets no box.
const MIN_REAL_BOXED = 170;

const evenAlignment = (text: string): CharacterAlignment => {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * 0.05),
    character_end_times_seconds: characters.map((_, i) => (i + 1) * 0.05),
  };
};

let failures = 0;
let boxed = 0;
let letteredTimings = 0;

for (const file of files) {
  const fixture = JSON.parse(
    readFileSync(resolve(dir, file), "utf8"),
  ) as Fixture;
  console.log(`\n${file}${fixture.synthetic ? " (synthetic)" : ""}`);

  for (const c of fixture.bubbles) {
    const id = fixture.synthetic ? c.bubbleId : c.bubbleId.slice(0, 8);
    const alignment =
      c.alignment ??
      (fixture.synthetic && c.text_with_cues
        ? evenAlignment(c.text_with_cues)
        : null);
    const missing = [
      !alignment && "alignment",
      !c.geometry && "geometry",
    ].filter(Boolean);
    if (!fixture.synthetic && missing.length) {
      failures++;
      console.log(`  FAIL ${c.bubbleId}: no ${missing.join(" or ")}`);
      continue;
    }

    const { words } = buildWordTimings(alignment);
    const geometry = c.geometry ?? {
      engine: "none",
      image: { w: 0, h: 0, sha: "" },
      lines: [],
    };
    const got = alignTimingsToGeometry(words, geometry);

    const lettered = words
      .map((w, i) => ({ w, boxes: got.boxesByTimingIndex[i]! }))
      .filter(({ w }) => /[a-z0-9]/i.test(w.word));
    const hits = lettered.filter(({ boxes }) => boxes.length).length;
    if (!fixture.synthetic) {
      boxed += hits;
      letteredTimings += lettered.length;
    }

    const errors: string[] = [];
    const { expect } = c;
    if (expect.minCoverage !== undefined && got.coverage < expect.minCoverage) {
      errors.push(`coverage below ${expect.minCoverage}`);
    }
    if (
      expect.coverage !== undefined &&
      Math.abs(got.coverage - expect.coverage) > 1e-4
    ) {
      errors.push(`coverage ${got.coverage}, expected ${expect.coverage}`);
    }
    if (
      expect.letteredWordCount !== undefined &&
      got.letteredWordCount !== expect.letteredWordCount
    ) {
      errors.push(
        `letteredWordCount ${got.letteredWordCount}, expected ${expect.letteredWordCount}`,
      );
    }
    if (
      expect.boxesByTimingIndex &&
      JSON.stringify(got.boxesByTimingIndex) !==
        JSON.stringify(expect.boxesByTimingIndex)
    ) {
      errors.push(
        `boxesByTimingIndex ${JSON.stringify(got.boxesByTimingIndex)}, expected ${JSON.stringify(expect.boxesByTimingIndex)}`,
      );
    }

    const owned = Math.round(got.coverage * got.letteredWordCount);
    console.log(
      `  ${errors.length ? "FAIL" : "ok  "} ${id}  coverage ${got.coverage.toFixed(2)} (${owned}/${got.letteredWordCount} boxes owned)  timing words boxed ${hits}/${lettered.length}`,
    );
    for (const { w, boxes } of lettered) {
      if (!boxes.length) console.log(`       unboxed: "${w.word}"`);
    }
    for (const e of errors) console.log(`       ${e}`);
    if (errors.length) failures++;
  }
}

console.log(
  `\ntiming words boxed ${boxed}/${letteredTimings} across the real bubbles`,
);
if (boxed < MIN_REAL_BOXED) {
  failures++;
  console.log(`FAIL fewer than ${MIN_REAL_BOXED} real timing words boxed`);
}
if (failures) {
  console.log(`${failures} case(s) failed`);
  process.exit(1);
}
console.log("all expectations met");
