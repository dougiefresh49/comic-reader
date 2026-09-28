import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * True when `DRY_RUN` is set to anything but "" or "0". Throws when it is on
 * and `VERCEL_ENV` is set: fakes never run in a deployment.
 */
export function isDryRun(): boolean {
  const flag = process.env.DRY_RUN;
  if (!flag || flag === "0") return false;
  if (process.env.VERCEL_ENV) throw new Error("DRY_RUN is local-only");
  return true;
}

/** `DRY_RUN_SCENARIO=gates` makes one face and one speaker unresolved. */
export function isGatesScenario(): boolean {
  return process.env.DRY_RUN_SCENARIO === "gates";
}

export function logSpend(
  service: string,
  unit: string,
  qty: number,
  note?: string,
): void {
  console.log(
    `[DRY_RUN] would spend: ${service} ${unit} ${qty}${note ? ` ${note}` : ""}`,
  );
}

export type FixtureBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
};

export type FixtureBubble = {
  legacyId: string;
  sortOrder: number;
  ocrText: string;
  type: string;
  speaker: string | null;
  emotion: string | null;
  side: string | null;
  characterType: string | null;
  voiceDescription: string | null;
  textWithCues: string | null;
};

export type FixturePage = {
  fixturePage: number;
  width: number;
  height: number;
  /** Roboflow centre-pixel boxes, the inverse of `mapPanelRows`. */
  panelPredictions: FixtureBox[];
  /** Roboflow centre-pixel boxes, the inverse of `mapBubbleRows`. */
  bubblePredictions: FixtureBox[];
  segmentationPredictions: Array<Record<string, unknown>>;
  bubbles: FixtureBubble[];
  faces: Array<{ characterName: string; confidence: number }>;
};

export type IngestFixture = {
  pages: FixturePage[];
  /** Keyed by character id (slug). */
  voiceDescriptions: Record<string, string>;
};

export const INGEST_FIXTURE_PATH = join("fixtures", "ingest", "pages.json");

let cached: IngestFixture | null = null;

/** Read from disk, not bundled, so production builds never carry fixtures. */
export function loadIngestFixture(): IngestFixture {
  cached ??= JSON.parse(
    readFileSync(join(process.cwd(), INGEST_FIXTURE_PATH), "utf8"),
  ) as IngestFixture;
  return cached;
}

/** Fixture page for a real page number: odd pages map to 1, even to 2. */
export function fixturePageFor(pageNumber: number): FixturePage {
  const pages = loadIngestFixture().pages;
  return pages[(Math.max(1, pageNumber) - 1) % pages.length]!;
}
