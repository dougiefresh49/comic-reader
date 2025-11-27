/**
 * Roboflow API utilities for text detection
 */

import { env } from "~/env.mjs";
import fs from "fs-extra";
import { join } from "path";
import sharp from "sharp";
import { boxesAreSimilar, isInside } from "./box-math";

export interface RoboflowPrediction {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  class?: string;
}

/**
 * Call Roboflow API to detect text regions
 */
export async function detectTextRegions(
  imageBuffer: Buffer,
  options: {
    outDir?: string;
    pageName?: string;
    useSpatialDedup?: boolean;
    spatialDedupTolerance?: number;
  },
): Promise<RoboflowPrediction[]> {
  console.log(`\n🔍 Detecting text regions with Roboflow...`);

  const base64Image = imageBuffer.toString("base64");

  const requestBody = {
    api_key: env.ROBOFLOW_API_KEY,
    inputs: {
      image: {
        type: "base64",
        value: base64Image,
      },
    },
  };

  const response = await fetch(env.ROBOFLOW_WORKFLOW_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error(`❌ Roboflow API Error:`);
    console.error(`  Status: ${response.status} ${response.statusText}`);
    console.error(`  Response: ${responseText.substring(0, 500)}`);
    throw new Error(
      `Roboflow API error: ${response.status} ${response.statusText}\n${responseText}`,
    );
  }

  const rawPredictions = parseRoboflowResponse(responseText);
  const centeredPredictions = convertCenterToTopLeft(rawPredictions);
  const deduplicatedPredictions = spatialDeduplication(
    centeredPredictions,
    options.spatialDedupTolerance,
    !options.useSpatialDedup,
  );
  const filteredPredictions = filterContainerBoxes(deduplicatedPredictions);
  console.log(`   ✓ Found ${centeredPredictions.length} raw predictions`);

  await debugPredictions(
    imageBuffer,
    centeredPredictions,
    options.pageName,
    options.outDir,
  );
  return filteredPredictions;
}

/**
 * Helpers
 */

async function debugPredictions(
  imageBuffer: Buffer,
  predictions: RoboflowPrediction[],
  pageName?: string,
  outDir?: string,
) {
  if (env.LOG_LEVEL !== "debug" || !pageName || !outDir) {
    console.log(
      `   🔍 Debug predictions... SKIPPED (LOG_LEVEL: ${env.LOG_LEVEL})`,
    );
    return;
  }
  await savePredictionsToFile(predictions, outDir, pageName);
  await createDebugVisualization(imageBuffer, predictions, pageName, outDir);
}

// Save predictions to file
async function savePredictionsToFile(
  predictions: RoboflowPrediction[],
  outDir: string,
  pageName: string,
) {
  await fs.ensureDir(outDir);
  const rawPredictionsFile = join(outDir, `${pageName}-raw.json`);
  await fs.writeFile(
    rawPredictionsFile,
    JSON.stringify(
      {
        page: pageName,
        timestamp: new Date().toISOString(),
        total: predictions.length,
        predictions: predictions.map((p, idx) => ({
          index: idx,
          x: p.x,
          y: p.y,
          width: p.width,
          height: p.height,
          confidence: p.confidence,
          class: p.class,
          area: p.width * p.height,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`   💾 Saved raw predictions to: ${rawPredictionsFile}`);
}

// Create debug visualization with bounding boxes drawn on the page
async function createDebugVisualization(
  imageBuffer: Buffer,
  predictions: RoboflowPrediction[],
  pageName: string,
  outDir: string,
) {
  try {
    const debugImage = await sharp(imageBuffer)
      .composite(
        predictions.map((p, idx) => ({
          input: Buffer.from(
            `<svg width="${Math.floor(p.width)}" height="${Math.floor(p.height)}">
              <rect x="0" y="0" width="${Math.floor(p.width)}" height="${Math.floor(p.height)}" 
                    fill="none" stroke="${idx % 2 === 0 ? "red" : "blue"}" stroke-width="16"/>
              <text x="5" y="20" fill="${idx % 2 === 0 ? "red" : "blue"}" font-size="16" font-weight="bold">${idx + 1}</text>
            </svg>`,
          ),
          left: Math.floor(p.x),
          top: Math.floor(p.y),
        })),
      )
      .png()
      .toBuffer();

    const debugVizPath = join(outDir, `${pageName}-debug-boxes.png`);
    await fs.writeFile(debugVizPath, debugImage);
    console.log(`   💾 Saved debug visualization: ${debugVizPath}`);
  } catch (error) {
    console.warn(`   ⚠️  Could not create debug visualization: ${error}`);
  }
}

/**
 * Parse Roboflow API response to extract predictions
 */
function parseRoboflowResponse(responseText: string): RoboflowPrediction[] {
  let data: {
    predictions?: RoboflowPrediction[];
    outputs?: Array<{
      predictions?: {
        predictions?: RoboflowPrediction[];
        image?: unknown;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };

  try {
    data = JSON.parse(responseText) as typeof data;
  } catch (error) {
    console.error(`❌ Failed to parse Roboflow response as JSON:`);
    console.error(
      `  Response (first 500 chars): ${responseText.substring(0, 500)}`,
    );
    throw new Error(`Invalid JSON response from Roboflow: ${error}`);
  }

  // Extract predictions from the nested structure
  // Roboflow workflow returns: { outputs: [{ predictions: { predictions: [...] } }] }
  let predictions: RoboflowPrediction[] = [];

  if (data.predictions && Array.isArray(data.predictions)) {
    // Direct predictions array (fallback)
    predictions = data.predictions;
  } else if (
    data.outputs &&
    Array.isArray(data.outputs) &&
    data.outputs.length > 0
  ) {
    // Nested structure: outputs[0].predictions.predictions
    const firstOutput = data.outputs[0];
    if (
      firstOutput?.predictions?.predictions &&
      Array.isArray(firstOutput.predictions.predictions)
    ) {
      predictions = firstOutput.predictions.predictions;
    }
  }

  if (predictions.length === 0) {
    console.warn(
      `  ⚠️  No predictions found in response. Full response structure:`,
    );
    console.warn(JSON.stringify(data, null, 2).substring(0, 1000));
  }

  return predictions;
}

/**
 * Convert center coordinates to top-left coordinates
 */
function convertCenterToTopLeft(
  predictions: RoboflowPrediction[],
): RoboflowPrediction[] {
  // Roboflow returns center coordinates (center_x, center_y, width, height)
  // Convert to top-left coordinates (x, y, width, height) for image extraction
  const converted = predictions.map((pred) => {
    // Convert center coordinates to top-left
    const x = pred.x - pred.width / 2;
    const y = pred.y - pred.height / 2;

    return {
      x: Math.max(0, x), // Ensure non-negative
      y: Math.max(0, y), // Ensure non-negative
      width: pred.width,
      height: pred.height,
      confidence: pred.confidence ?? 0.5,
      class: pred.class,
    };
  });

  // Log conversion for first few predictions
  if (predictions.length > 0) {
    console.log(
      `   Converting ${predictions.length} predictions from center to top-left coordinates`,
    );
    const first = predictions[0]!;
    const firstConverted = converted[0]!;
    console.log(
      `   Example: center(${Math.floor(first.x)}, ${Math.floor(first.y)}) → top-left(${Math.floor(firstConverted.x)}, ${Math.floor(firstConverted.y)})`,
    );
  }

  return converted;
}

/**
 * Filter out container boxes (boxes that contain other boxes)
 */
function filterContainerBoxes(
  predictions: RoboflowPrediction[],
): RoboflowPrediction[] {
  console.log(`\n🔧 Filtering container boxes...`);

  const filteredPredictions = predictions.filter((bigBox) => {
    // Check if this box contains any other smaller box (excluding itself)
    const hasChild = predictions.some((smallBox) => {
      // Skip comparing the box to itself
      if (bigBox === smallBox) return false;

      // Check if smallBox is completely inside bigBox
      return isInside(smallBox, bigBox);
    });

    // If it has a child, it's a container box - remove it
    return !hasChild;
  });

  const removed = predictions.length - filteredPredictions.length;
  console.log(
    `   ✓ After container filter: ${filteredPredictions.length} (removed ${removed} container boxes)`,
  );

  return filteredPredictions;
}

function spatialDeduplication(
  predictions: RoboflowPrediction[],
  tolerance?: number,
  shouldSkip?: boolean,
): RoboflowPrediction[] {
  if (shouldSkip || !tolerance) {
    console.log(
      `\n🔧 Spatial deduplication... SKIPPED (tolerance: ${tolerance})`,
    );
    return predictions;
  }
  const unique: RoboflowPrediction[] = [];

  for (const pred of predictions) {
    const duplicate = unique.find((existing) =>
      boxesAreSimilar(pred, existing, tolerance),
    );
    if (!duplicate) {
      unique.push(pred);
    } else if (pred.confidence > duplicate.confidence) {
      // Replace with higher confidence
      const index = unique.indexOf(duplicate);
      unique[index] = pred;
    }
  }

  const removed = predictions.length - unique.length;
  console.log(
    `   ✓ After spatial deduplication: ${unique.length} (removed ${removed})`,
  );

  return unique;
}
