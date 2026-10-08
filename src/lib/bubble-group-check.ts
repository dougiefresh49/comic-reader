/**
 * A second look at a bubble box the duplicate filter is unsure of (#343).
 * `filterDuplicateBubbles` drops a container when the boxes it holds cover
 * it; when the filter marks a drop `unsure` (the reasons are listed on
 * `BubbleDrop.unsure`), this asks `GEMINI_FAST` whether the container is a balloon of its own or only a
 * box around the smaller balloons, by asking for any words in it that no
 * smaller balloon covers. It can only keep a container: such words ("own")
 * keep it, and an error, a timeout or an unclear reply keeps it too, since a
 * dropped balloon is a line a kid never hears (decision row 238). No such
 * words ("group") lets the drop stand.
 */
import { createPartFromBase64, createPartFromText } from "@google/genai";
import sharp from "sharp";
import { withGeminiFallback } from "~/lib/gemini-client";
import { generateContentLogged, type LlmCallMeta } from "~/lib/llm-usage";
import { GEMINI_FAST } from "~/lib/models";
import type { PanelBoundingBox } from "~/types/panels";

/**
 * The question, sent after the marked crop. Its opening is the DRY_RUN
 * fake's key. It asks for the words outside the red frames rather than a
 * yes or no, and counts a word a red frame cuts as outside, so a loose red
 * box over a balloon's own lettering cannot hide it. On smoke page 2's 7
 * container drops plus 6 real balloons (2026-10-07, `GEMINI_FAST`, 5 runs)
 * this wording found words in every real balloon on every run, and read one
 * group box as a balloon once (an extra box). A version that counted a cut
 * word as inside missed the two cut-lettering balloons in 9 of 10 answers,
 * and a one-word OWN/GROUP question called four real balloons a group.
 */
export const BUBBLE_GROUP_PROMPT = `This picture is cut from a comic book page. The blue frame marks one area a detector found. Each red frame marks a speech balloon or caption already found.

Copy every word of lettering that is inside the blue frame but not wholly inside a red frame. A word that a red frame cuts through counts as outside: copy it.

Reply with JSON only: {"outside": "<those words>"}. Use "" when there are none.`;

/** Padding around the container in the crop, as a share of its longer side. */
const CROP_PAD = 0.08;
/** The crop's longer side is scaled down to this many pixels, never up. */
const CROP_MAX_PX = 1024;
/** A reply slower than this keeps the container. */
const CHECK_TIMEOUT_MS = 30_000;
/**
 * Time one page may spend on checks. Once spent, each remaining unsure
 * container on the page is kept without a call, so a slow model cannot hold
 * the step: three timed-out checks, or dozens of normal ones (a check took
 * under a second on average in the #343 trials).
 */
export const GROUP_CHECK_PAGE_BUDGET_MS = 90_000;

/**
 * Pure: "own" when the reply's `outside` holds anything but whitespace, so a
 * balloon of only digits or punctuation ("3... 2... 1...") keeps too;
 * "group" when it is blank; null when the reply has no JSON object with an
 * `outside` string.
 */
export function parseGroupAnswer(reply: string): "own" | "group" | null {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  if (!json) return null;
  let outside: unknown;
  try {
    outside = (JSON.parse(json) as { outside?: unknown }).outside;
  } catch {
    return null;
  }
  if (typeof outside !== "string") return null;
  return /\S/.test(outside) ? "own" : "group";
}

/**
 * The container cut from the page with some padding, framed in blue, with
 * each `found` box framed in red. Frames sit just outside their boxes so they
 * never cover the lettering. Boxes are pixel top-left, as the filter gets
 * them. WebP.
 */
export async function groupCheckCrop(
  page: Buffer | Uint8Array,
  container: PanelBoundingBox,
  found: PanelBoundingBox[],
): Promise<Buffer> {
  const image = sharp(page);
  const { width = 0, height = 0 } = await image.metadata();
  const pad = Math.round(CROP_PAD * Math.max(container.w, container.h));
  const left = Math.max(0, Math.floor(container.x - pad));
  const top = Math.max(0, Math.floor(container.y - pad));
  const right = Math.min(width, Math.ceil(container.x + container.w + pad));
  const bottom = Math.min(height, Math.ceil(container.y + container.h + pad));
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) throw new Error("container lies outside the page");

  const stroke = Math.max(3, Math.round(Math.max(w, h) / 200));
  const frame = (b: PanelBoundingBox, color: string) =>
    `<rect x="${b.x - left - stroke / 2}" y="${b.y - top - stroke / 2}" width="${b.w + stroke}" height="${b.h + stroke}" fill="none" stroke="${color}" stroke-width="${stroke}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${frame(container, "#0050ff")}${found.map((b) => frame(b, "#ff0000")).join("")}</svg>`;

  // Three pipelines: sharp runs a resize before a composite whatever the call
  // order, and the frames are drawn in unscaled crop pixels.
  const crop = await image
    .extract({ left, top, width: w, height: h })
    .png()
    .toBuffer();
  const framed = await sharp(crop)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
  return sharp(framed)
    .resize({
      width: CROP_MAX_PX,
      height: CROP_MAX_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp()
    .toBuffer();
}

/**
 * Asks whether `container` is a balloon of its own. `found` is every box the
 * filter finally keeps that touches it: the boxes it drops for, and a
 * neighbour whose words poke into it, which then do not read as its own.
 * A box the filter drops is never framed, so a loose box cannot hide the
 * container's words. `keep` is false only on a clear "group" answer; `note`
 * is what the drop log line prints, the reply included.
 */
export async function checkBubbleGroup(
  loadPage: () => Promise<Buffer | Uint8Array>,
  container: PanelBoundingBox,
  found: PanelBoundingBox[],
  meta: LlmCallMeta,
): Promise<{ keep: boolean; note: string }> {
  try {
    const crop = await groupCheckCrop(await loadPage(), container, found);
    const response = await withGeminiFallback((gemini) =>
      generateContentLogged(
        gemini,
        {
          model: GEMINI_FAST,
          contents: [
            createPartFromBase64(crop.toString("base64"), "image/webp"),
            createPartFromText(BUBBLE_GROUP_PROMPT),
          ],
          config: { abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS) },
        },
        meta,
      ),
    );
    const reply = (response.text ?? "").trim().replace(/\s+/g, " ");
    const answer = parseGroupAnswer(reply);
    if (answer === null) {
      return {
        keep: true,
        note: `gemini reply unclear, kept: ${reply.slice(0, 80)}`,
      };
    }
    return {
      keep: answer === "own",
      note: `gemini: ${answer}, ${reply.slice(0, 80)}`,
    };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(
      0,
      120,
    );
    return { keep: true, note: `gemini check failed, kept: ${message}` };
  }
}
