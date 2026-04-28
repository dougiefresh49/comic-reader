/**
 * Phase 2 — shot planning.
 *
 * Reads bubbles.json + audio-timestamps.json + pages-webp/, asks Gemini
 * Vision (per page) to identify panels with cinematic descriptions, maps
 * bubbles to panels by spatial overlap, and applies grouping rules to
 * produce shot-plan.json.
 *
 * Reddit-derived hardening (Seedance/Venice content filter):
 *   - sceneDescription is built from cinematic vocabulary only
 *   - IP names (e.g. "Spider-Man") never appear in sceneDescription;
 *     they live in the structured `characters[]` array, used at storyboard
 *     time to look up visual descriptions from the registry
 */

import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";

// ─── Public types ─────────────────────────────────────────────────────────────

export type PanelRegion =
  | "top-third"
  | "top-half"
  | "bottom-half"
  | "bottom-third"
  | "full-page"
  | "left-half"
  | "right-half";

export type ShotType =
  | "establishing"
  | "dialogue"
  | "action"
  | "narration"
  | "reaction";

export interface DialogueLine {
  speaker: string;
  text: string;
  audioFile: string;
}

export interface Shot {
  shotId: string;
  pageIndex: number;
  type: ShotType;
  characters: string[];
  primarySpeaker: string | null;
  sceneDescription: string;
  dialogue: DialogueLine[];
  audioFiles: string[];
  estimatedDurationSeconds: number;
  sourcePageKey: string;
  panelRegion: PanelRegion;
}

export interface ShotPlan {
  bookId: string;
  issueId: string;
  generatedAt: string;
  totalShots: number;
  estimatedDurationSeconds: number;
  shots: Shot[];
}

// ─── Inputs ───────────────────────────────────────────────────────────────────

interface BubbleStyle {
  left: string;
  top: string;
  width: string;
  height: string;
}

export interface BubbleInput {
  id: string;
  type: "SPEECH" | "NARRATION" | "CAPTION" | "SFX" | "BACKGROUND";
  speaker: string | null;
  ocr_text?: string | null;
  textWithCues?: string | null;
  ignored?: boolean;
  style?: BubbleStyle;
}

export interface AudioTimestamp {
  alignment?: {
    character_end_times_seconds?: number[];
  } | null;
  normalized_alignment?: {
    character_end_times_seconds?: number[];
  } | null;
}

// ─── Gemini Vision per-page analysis ──────────────────────────────────────────

interface PanelVision {
  region: PanelRegion;
  setting: string;
  action: string;
  mood: string;
  cameraStyle: string;
}

interface PageVisionAnalysis {
  panelCount: number;
  panels: PanelVision[];
  /** 1-indexed panel after which a scene break is recommended; null = no break */
  sceneBreakAfterPanel: number | null;
  /** Whether this page's overall location/time is materially different
   *  from the previous page (signals "insert establishing shot before this"). */
  newSceneFromPreviousPage: boolean;
}

const VISION_PROMPT = `You are a film storyboard analyst describing a single comic-book page that will be turned into a video. The page image is attached.

For each visually distinct panel on the page, describe it in **cinematic language** suitable as a prompt for an AI video model:
  - "setting"      — location and atmosphere (e.g. "rain-slicked rooftop in a neon-lit metropolis at night")
  - "action"       — what is physically happening in the panel
  - "mood"         — emotional tone (one or two words: "tense", "elegiac", "frantic")
  - "cameraStyle"  — shot type and composition language: "low-angle wide shot", "tight close-up with shallow depth of field", "Dutch angle medium shot", etc.
  - "region"       — where on the page the panel sits, picked from this list:
      "top-third" | "top-half" | "bottom-half" | "bottom-third" | "full-page" | "left-half" | "right-half"

CRITICAL RULES — these descriptions will be sent to a generative AI with strict content filters:
  1. NEVER mention real people or copyrighted character names ("Spider-Man", "Splinter", "Donatello"). Describe characters only by visible traits — e.g. "an anthropomorphic turtle in a blue mask wielding twin katanas" not "Leonardo".
  2. Avoid proper nouns from real-world IP. Describe brands, vehicles, and locations generically.
  3. Cinematic vocabulary is your shield — favor terms like "depth of field", "rim lighting", "low-angle", "tracking shot", "lens flare".

Also identify whether THIS page's overall location/time is meaningfully different from the previous page (a scene change). And whether a scene break should occur within the page (after which panel).

Return ONLY this JSON shape, no markdown fences, no commentary:

{
  "panelCount": number,
  "panels": [
    { "region": "...", "setting": "...", "action": "...", "mood": "...", "cameraStyle": "..." }
  ],
  "sceneBreakAfterPanel": number | null,
  "newSceneFromPreviousPage": boolean
}`;

export async function analyzePage(
  gemini: GoogleGenAI,
  pageImageBuffer: Buffer,
  pageNumber: number,
  isFirstPage: boolean,
  // Imported lazily to avoid circular-import surprises
  geminiModel: string,
): Promise<PageVisionAnalysis> {
  const promptWithContext = isFirstPage
    ? `${VISION_PROMPT}\n\nThis is page 1 of the comic. "newSceneFromPreviousPage" should be true.`
    : `${VISION_PROMPT}\n\nThis is page ${pageNumber}. Compare to the previous page's likely setting in your judgment.`;

  const imagePart = createPartFromBase64(
    pageImageBuffer.toString("base64"),
    "image/webp",
  );
  const textPart = createPartFromText(promptWithContext);

  const response = await gemini.models.generateContent({
    model: geminiModel,
    contents: [imagePart, textPart],
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error(`Empty Gemini response for page ${pageNumber}`);
  }

  let jsonText = text;
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(jsonText);
  if (fence) jsonText = fence[1] ?? jsonText;
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(
      `Page ${pageNumber}: no JSON in Gemini response: ${text.slice(0, 200)}`,
    );
  }
  return JSON.parse(jsonText.slice(start, end + 1)) as PageVisionAnalysis;
}

// ─── Bubble → panel mapping ───────────────────────────────────────────────────

interface BubbleCenter {
  cx: number; // 0..100
  cy: number; // 0..100
}

function bubbleCenter(b: BubbleInput): BubbleCenter | null {
  const s = b.style;
  if (!s) return null;
  const left = parseFloat(s.left);
  const top = parseFloat(s.top);
  const width = parseFloat(s.width);
  const height = parseFloat(s.height);
  if ([left, top, width, height].some((n) => Number.isNaN(n))) return null;
  return { cx: left + width / 2, cy: top + height / 2 };
}

/**
 * Returns the y-range and x-range a panel region covers, expressed as
 * 0..100 percentages of the page. Used to score which region a bubble
 * center falls into.
 */
function regionBounds(region: PanelRegion): {
  yMin: number;
  yMax: number;
  xMin: number;
  xMax: number;
} {
  switch (region) {
    case "top-third":
      return { yMin: 0, yMax: 33, xMin: 0, xMax: 100 };
    case "top-half":
      return { yMin: 0, yMax: 50, xMin: 0, xMax: 100 };
    case "bottom-half":
      return { yMin: 50, yMax: 100, xMin: 0, xMax: 100 };
    case "bottom-third":
      return { yMin: 67, yMax: 100, xMin: 0, xMax: 100 };
    case "full-page":
      return { yMin: 0, yMax: 100, xMin: 0, xMax: 100 };
    case "left-half":
      return { yMin: 0, yMax: 100, xMin: 0, xMax: 50 };
    case "right-half":
      return { yMin: 0, yMax: 100, xMin: 50, xMax: 100 };
  }
}

/**
 * Pick the panel whose region most tightly contains the bubble's center.
 * Tighter (smaller area) regions win ties so a bubble in top-third is
 * preferred over the page-spanning full-page when both match.
 */
export function mapBubbleToPanelIndex(
  bubble: BubbleInput,
  panels: PanelVision[],
): number {
  if (panels.length === 0) return 0;
  const center = bubbleCenter(bubble);
  if (!center) return 0;
  const matches: Array<{ index: number; area: number }> = [];
  for (let i = 0; i < panels.length; i++) {
    const b = regionBounds(panels[i]!.region);
    const inside =
      center.cy >= b.yMin &&
      center.cy <= b.yMax &&
      center.cx >= b.xMin &&
      center.cx <= b.xMax;
    if (inside) {
      const area = (b.yMax - b.yMin) * (b.xMax - b.xMin);
      matches.push({ index: i, area });
    }
  }
  if (matches.length === 0) return 0;
  matches.sort((a, b) => a.area - b.area);
  return matches[0]!.index;
}

// ─── Audio duration ───────────────────────────────────────────────────────────

function bubbleDurationSeconds(ts: AudioTimestamp | undefined): number {
  if (!ts) return 0;
  const ends =
    ts.normalized_alignment?.character_end_times_seconds ??
    ts.alignment?.character_end_times_seconds;
  if (!ends || ends.length === 0) return 0;
  return ends[ends.length - 1] ?? 0;
}

// ─── Shot building ────────────────────────────────────────────────────────────

interface BuildShotsArgs {
  bookId: string;
  issueId: string;
  bubblesByPage: Record<string, BubbleInput[]>;
  audioTimestamps: Record<string, AudioTimestamp>;
  pageAnalyses: Map<number, PageVisionAnalysis>;
}

const MAX_SHOT_DURATION_S = 10;
const PADDING_BETWEEN_LINES_S = 0.3;

function pageNumFromKey(key: string): number {
  const m = /page-?0*(\d+)/i.exec(key);
  return m ? parseInt(m[1]!, 10) : 0;
}

function pageKeyFromNum(n: number): string {
  return `page-${String(n).padStart(2, "0")}.jpg`;
}

function buildSceneDescription(panel: PanelVision): string {
  // Cinematic phrasing only; never includes character names.
  const parts = [panel.cameraStyle, panel.setting, panel.action, panel.mood]
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.join(" — ");
}

function classifyShot(
  shotBubbles: BubbleInput[],
  characters: string[],
): ShotType {
  const types = new Set(shotBubbles.map((b) => b.type));
  if (types.has("NARRATION") || types.has("CAPTION")) return "narration";
  if (characters.length === 0) return "establishing";
  if (characters.length >= 3) return "action";
  // 1–2 characters with dialogue → standard dialogue shot
  return "dialogue";
}

export function buildShots(args: BuildShotsArgs): Shot[] {
  const { bubblesByPage, audioTimestamps, pageAnalyses } = args;
  const shots: Shot[] = [];
  let shotCounter = 0;
  const nextShotId = () => {
    shotCounter += 1;
    return `s${String(shotCounter).padStart(3, "0")}`;
  };

  const pageKeys = Object.keys(bubblesByPage).sort();
  for (const pageKey of pageKeys) {
    const pageNum = pageNumFromKey(pageKey);
    const analysis = pageAnalyses.get(pageNum);
    const pageBubbles = (bubblesByPage[pageKey] ?? []).filter(
      (b) => !b.ignored && b.type !== "SFX" && b.type !== "BACKGROUND",
    );

    if (!analysis) {
      // Couldn't analyze the page — skip it. Phase 2 surfaces a warning.
      continue;
    }

    // 1. Insert an establishing shot if Gemini flagged a new scene.
    if (analysis.newSceneFromPreviousPage && analysis.panels.length > 0) {
      const firstPanel = analysis.panels[0]!;
      shots.push({
        shotId: nextShotId(),
        pageIndex: pageNum,
        type: "establishing",
        characters: [],
        primarySpeaker: null,
        sceneDescription: buildSceneDescription(firstPanel),
        dialogue: [],
        audioFiles: [],
        estimatedDurationSeconds: 4.0,
        sourcePageKey: pageKey,
        panelRegion: firstPanel.region,
      });
    }

    if (pageBubbles.length === 0) {
      // No bubbles → just an establishing/silent shot per panel.
      for (const panel of analysis.panels) {
        shots.push({
          shotId: nextShotId(),
          pageIndex: pageNum,
          type: "establishing",
          characters: [],
          primarySpeaker: null,
          sceneDescription: buildSceneDescription(panel),
          dialogue: [],
          audioFiles: [],
          estimatedDurationSeconds: 3.5,
          sourcePageKey: pageKey,
          panelRegion: panel.region,
        });
      }
      continue;
    }

    // 2. Annotate each bubble with its panel index.
    interface AnnotatedBubble {
      bubble: BubbleInput;
      panelIndex: number;
    }
    const annotated: AnnotatedBubble[] = pageBubbles.map((bubble) => ({
      bubble,
      panelIndex: mapBubbleToPanelIndex(bubble, analysis.panels),
    }));

    // 3. Group into shots: same panel + same primary speaker.
    //    Speaker change OR panel change OR NARRATION/CAPTION = new shot.
    //    Cap at MAX_SHOT_DURATION_S; if exceeded, split.
    interface InProgressShot {
      panelIndex: number;
      bubbles: BubbleInput[];
      primarySpeaker: string | null;
      audioFiles: string[];
      dialogue: DialogueLine[];
      duration: number;
    }
    let current: InProgressShot | null = null;

    const flush = () => {
      if (!current) return;
      const panel = analysis.panels[current.panelIndex] ?? analysis.panels[0]!;
      const characters = uniqueSpeakersIn(current.bubbles);
      const type = classifyShot(current.bubbles, characters);
      shots.push({
        shotId: nextShotId(),
        pageIndex: pageNum,
        type,
        characters,
        primarySpeaker: current.primarySpeaker,
        sceneDescription: buildSceneDescription(panel),
        dialogue: current.dialogue,
        audioFiles: current.audioFiles,
        estimatedDurationSeconds: Math.round(current.duration * 10) / 10,
        sourcePageKey: pageKey,
        panelRegion: panel.region,
      });
      current = null;
    };

    for (const { bubble, panelIndex } of annotated) {
      const isNarration =
        bubble.type === "NARRATION" || bubble.type === "CAPTION";
      const speaker = bubble.speaker ?? null;
      const dur = bubbleDurationSeconds(audioTimestamps[bubble.id]);
      const text = bubble.textWithCues ?? bubble.ocr_text ?? "";
      const audioFile = `${bubble.id}.mp3`;
      const lineForShot: DialogueLine = {
        speaker: speaker ?? "Narrator",
        text,
        audioFile,
      };

      // Narration always its own shot.
      if (isNarration) {
        flush();
        current = {
          panelIndex,
          bubbles: [bubble],
          primarySpeaker: speaker,
          audioFiles: [audioFile],
          dialogue: [lineForShot],
          duration: dur,
        };
        flush();
        continue;
      }

      const wouldExceed =
        current &&
        current.duration + PADDING_BETWEEN_LINES_S + dur > MAX_SHOT_DURATION_S;
      const speakerChanged = current && current.primarySpeaker !== speaker;
      const panelChanged = current && current.panelIndex !== panelIndex;

      if (!current || speakerChanged || panelChanged || wouldExceed) {
        flush();
        current = {
          panelIndex,
          bubbles: [bubble],
          primarySpeaker: speaker,
          audioFiles: [audioFile],
          dialogue: [lineForShot],
          duration: dur,
        };
      } else {
        current.bubbles.push(bubble);
        current.audioFiles.push(audioFile);
        current.dialogue.push(lineForShot);
        current.duration += PADDING_BETWEEN_LINES_S + dur;
      }
    }
    flush();

    // Optional mid-page scene break — currently a no-op marker. Future:
    // could insert a transition shot at analysis.sceneBreakAfterPanel.
  }

  return shots;
}

function uniqueSpeakersIn(bubbles: BubbleInput[]): string[] {
  const set = new Set<string>();
  for (const b of bubbles) {
    if (b.speaker) set.add(b.speaker);
  }
  return Array.from(set);
}

// ─── Review table printer ─────────────────────────────────────────────────────

export function printShotTable(plan: ShotPlan): void {
  const totalMin = Math.floor(plan.estimatedDurationSeconds / 60);
  const totalSec = Math.round(plan.estimatedDurationSeconds % 60);

  console.log(`\n📋 Shot Plan — ${plan.bookId} / ${plan.issueId}`);
  console.log(
    `   ${plan.totalShots} shots · ~${totalMin}m ${String(totalSec).padStart(2, "0")}s total\n`,
  );

  const header = `   Shot  Page  Type           Characters                 Duration  Description`;
  const sep = "   " + "─".repeat(85);
  console.log(header);
  console.log(sep);

  for (const s of plan.shots) {
    const id = s.shotId.padEnd(6);
    const page = String(s.pageIndex).padStart(2, "0").padEnd(6);
    const type = s.type.padEnd(15);
    const chars = (s.characters.join(", ") || "—").slice(0, 26).padEnd(27);
    const dur = `${s.estimatedDurationSeconds.toFixed(1)}s`.padEnd(10);
    const desc = s.sceneDescription.slice(0, 70);
    console.log(`   ${id}${page}${type}${chars}${dur}${desc}`);
  }

  // Phase 3 cost estimate at $0.05/image
  const phase3Cost = plan.totalShots * 0.05;
  // Phase 4 cost guess at $0.50–$2.00/clip
  const phase4Low = plan.totalShots * 0.5;
  const phase4High = plan.totalShots * 2.0;
  console.log(
    `\nEstimated Venice spend (phases 3–4): ~$${phase3Cost.toFixed(2)} (images) + $${phase4Low.toFixed(0)}–$${phase4High.toFixed(0)} (videos)`,
  );
  console.log(
    "\nReview the shot plan. Edit shot-plan.json manually to merge, split, or adjust shots.",
  );
}
