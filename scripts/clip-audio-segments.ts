#!/usr/bin/env node

/**
 * Extract audio segments from a video file based on timestamps and concatenate them
 *
 * Takes a JSON file with start/end times and extracts those segments from a video,
 * then concatenates them into a single audio file.
 */

import fs from "fs-extra";
import { join, dirname, basename, extname, resolve } from "path";
import { fileURLToPath } from "url";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// Set ffmpeg path if ffmpeg-static is available
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

interface Timestamp {
  start: string; // Format: "HH:MM:SS" or "MM:SS" or seconds as string
  end: string;
}

/**
 * Convert time string to seconds
 */
function timeToSeconds(timeStr: string): number {
  const parts = timeStr.split(":").map(Number);
  if (parts.length === 3) {
    // HH:MM:SS
    return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  } else if (parts.length === 2) {
    // MM:SS
    return parts[0]! * 60 + parts[1]!;
  } else {
    // Assume seconds
    return parts[0]! || 0;
  }
}

/**
 * Convert seconds to time string (HH:MM:SS)
 */
function secondsToTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * Calculate duration of a segment
 */
function getDuration(start: string, end: string): number {
  return timeToSeconds(end) - timeToSeconds(start);
}

/**
 * Parse command-line arguments
 */
function parseArgs(): {
  character?: string;
  videoFile?: string;
  timestampsFile?: string;
  outputFile?: string;
} {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run clip-audio-segments [options]

Options:
  --character=NAME, -c NAME       Character name (e.g., "mikey", "shredder")
                                  Automatically finds {name}.mp4 and timestamps/{name}-timestamps.json
  --video=FILE, -v FILE           Path to input video file (required if --character not used)
  --timestamps=FILE, -t FILE      Path to JSON file with timestamps (required if --character not used)
  --output=FILE, -o FILE          Path to output audio file (optional, defaults to audio/{character}_extracted.mp3)
  --help, -h                      Show this help message

Examples:
  npm run clip-audio-segments --character=mikey
  npm run clip-audio-segments -c shredder
  npm run clip-audio-segments --video=video-test-files/mikey.mp4 --timestamps=video-test-files/timestamps/mikey-timestamps.json
`);
    process.exit(0);
  }

  let character: string | undefined;
  let videoFile: string | undefined;
  let timestampsFile: string | undefined;
  let outputFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith("--character=") || arg.startsWith("-c=")) {
      character = arg.split("=")[1] || "";
    } else if (arg === "--character" || arg === "-c") {
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        character = nextArg;
        i++;
      }
    } else if (arg.startsWith("--video=") || arg.startsWith("-v=")) {
      videoFile = arg.split("=")[1] || "";
    } else if (arg === "--video" || arg === "-v") {
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        videoFile = nextArg;
        i++;
      }
    } else if (arg.startsWith("--timestamps=") || arg.startsWith("-t=")) {
      timestampsFile = arg.split("=")[1] || "";
    } else if (arg === "--timestamps" || arg === "-t") {
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        timestampsFile = nextArg;
        i++;
      }
    } else if (arg.startsWith("--output=") || arg.startsWith("-o=")) {
      outputFile = arg.split("=")[1] || "";
    } else if (arg === "--output" || arg === "-o") {
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        outputFile = nextArg;
        i++;
      }
    }
  }

  return { character, videoFile, timestampsFile, outputFile };
}

/**
 * Extract a single audio segment
 */
async function extractSegment(
  videoPath: string,
  start: string,
  duration: number,
  outputPath: string,
  bitrate: number = 192,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(start)
      .duration(duration)
      .audioCodec("libmp3lame")
      .audioBitrate(bitrate)
      .noVideo()
      .on("end", () => {
        resolve();
      })
      .on("error", (err) => {
        reject(new Error(`FFmpeg error: ${err.message}`));
      })
      .save(outputPath);
  });
}

/**
 * Calculate optimal bitrate to keep file under target size (MB)
 * Formula: bitrate (kbps) = (targetSizeMB * 8000) / durationSeconds
 */
function calculateOptimalBitrate(
  durationSeconds: number,
  targetSizeMB: number = 9.5,
): number {
  // Calculate bitrate needed for target size (leave 0.5MB buffer)
  const bitrate = (targetSizeMB * 8000) / durationSeconds;

  // Clamp between reasonable values (64 kbps minimum, 320 kbps maximum)
  return Math.max(64, Math.min(320, Math.floor(bitrate)));
}

/**
 * Concatenate multiple audio files
 */
async function concatenateAudio(
  inputFiles: string[],
  outputPath: string,
  segmentsDir: string,
  bitrate: number = 192,
): Promise<void> {
  // Create the concat list file in the segments directory
  const listPath = join(segmentsDir, `concat_${Date.now()}.txt`);

  // Use absolute paths in the concat file - this avoids working directory issues
  const listContent = inputFiles
    .map((file) => {
      // Ensure absolute path
      const absPath = file.startsWith("/") ? file : resolve(PROJECT_ROOT, file);
      // Escape single quotes in path
      const escapedPath = absPath.replace(/'/g, "'\\''");
      return `file '${escapedPath}'`;
    })
    .join("\n");

  // Write the concat file
  await fs.writeFile(listPath, listContent, "utf-8");

  // Verify the file was written
  if (!(await fs.pathExists(listPath))) {
    throw new Error(`Failed to create concat list file: ${listPath}`);
  }

  // Verify all input files exist
  for (const file of inputFiles) {
    if (!(await fs.pathExists(file))) {
      throw new Error(`Input file not found: ${file}`);
    }
  }

  // Debug: Log the concat file content
  console.log(`   📄 Concat list file: ${listPath}`);
  console.log(`   📄 Concat list contains ${inputFiles.length} files`);

  // Use absolute path for list file
  const absoluteListPath = resolve(listPath);
  const absoluteOutputPath = resolve(PROJECT_ROOT, outputPath);

  return new Promise((resolvePromise, reject) => {
    ffmpeg()
      .input(absoluteListPath) // Use absolute path
      .inputOptions(["-f", "concat", "-safe", "0"])
      .audioCodec("libmp3lame")
      .audioBitrate(bitrate)
      .on("end", () => {
        resolvePromise();
      })
      .on("error", (err) => {
        reject(new Error(`FFmpeg concat error: ${err.message}`));
      })
      .save(absoluteOutputPath);
  });
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log("🎬 Starting audio segment extraction...\n");

    const { character, videoFile, timestampsFile, outputFile } = parseArgs();

    // Determine file paths based on character name or explicit paths
    let videoPath: string;
    let timestampsPath: string;
    let outputPath: string;

    if (character) {
      // Use character name to auto-detect files
      const videoTestDir = join(PROJECT_ROOT, "video-test-files");
      videoPath = join(videoTestDir, `${character}.mp4`);
      timestampsPath = join(
        videoTestDir,
        "timestamps",
        `${character}-timestamps.json`,
      );

      // Determine output path
      if (outputFile) {
        outputPath = join(PROJECT_ROOT, outputFile);
      } else {
        // Default output to audio/{character}_extracted.mp3
        outputPath = join(videoTestDir, "audio", `${character}_extracted.mp3`);
      }
    } else {
      // Use explicit file paths
      if (!videoFile || !timestampsFile) {
        console.error(
          "❌ Error: Either --character or both --video and --timestamps are required",
        );
        console.error("   Use --help for usage information");
        process.exit(1);
      }
      videoPath = join(PROJECT_ROOT, videoFile);
      timestampsPath = join(PROJECT_ROOT, timestampsFile);

      // Determine output path
      if (outputFile) {
        outputPath = join(PROJECT_ROOT, outputFile);
      } else {
        const videoBase = basename(videoPath, extname(videoPath));
        const outputDir = dirname(videoPath);
        outputPath = join(outputDir, `${videoBase}_extracted.mp3`);
      }
    }

    // Ensure output directory exists
    const outputDir = dirname(outputPath);
    await fs.ensureDir(outputDir);

    console.log(`📹 Video file: ${videoPath}`);
    console.log(`📋 Timestamps file: ${timestampsPath}`);
    console.log(`🎵 Output file: ${outputPath}\n`);

    // Check if files exist
    if (!(await fs.pathExists(videoPath))) {
      console.error(`❌ Video file not found: ${videoPath}`);
      process.exit(1);
    }

    if (!(await fs.pathExists(timestampsPath))) {
      console.error(`❌ Timestamps file not found: ${timestampsPath}`);
      process.exit(1);
    }

    // Load timestamps
    console.log("📖 Loading timestamps...");
    const timestampsContent = await fs.readFile(timestampsPath, "utf-8");
    const timestamps: Timestamp[] = JSON.parse(timestampsContent);

    if (!Array.isArray(timestamps) || timestamps.length === 0) {
      console.error("❌ Timestamps file must contain a non-empty array");
      process.exit(1);
    }

    console.log(`   ✓ Found ${timestamps.length} segments\n`);

    // Calculate total duration first to determine optimal bitrate
    const totalDuration = timestamps.reduce((sum, seg) => {
      return sum + getDuration(seg.start, seg.end);
    }, 0);

    // Calculate optimal bitrate to keep file under 10MB
    const optimalBitrate = calculateOptimalBitrate(totalDuration, 9.5);
    const estimatedSizeMB = (optimalBitrate * totalDuration) / 8000;

    console.log(`📊 Audio settings:`);
    console.log(`   Total duration: ${secondsToTime(totalDuration)}`);
    console.log(`   Bitrate: ${optimalBitrate} kbps`);
    console.log(`   Estimated size: ${estimatedSizeMB.toFixed(2)} MB\n`);

    // Create segments directory (user can manually delete later)
    const segmentsDir = join(dirname(videoPath), "segments");
    await fs.ensureDir(segmentsDir);

    // Extract each segment
    console.log("✂️  Extracting segments...");
    const segmentPaths: string[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const segment = timestamps[i]!;
      const duration = getDuration(segment.start, segment.end);

      if (duration <= 0) {
        console.warn(
          `   ⚠️  Segment ${i + 1}: Invalid duration (start: ${segment.start}, end: ${segment.end}), skipping`,
        );
        continue;
      }

      const segmentPath = join(
        segmentsDir,
        `segment_${String(i + 1).padStart(3, "0")}.mp3`,
      );

      console.log(
        `   [${i + 1}/${timestamps.length}] ${segment.start} → ${segment.end} (${duration.toFixed(2)}s)`,
      );

      try {
        await extractSegment(
          videoPath,
          segment.start,
          duration,
          segmentPath,
          optimalBitrate,
        );
        segmentPaths.push(segmentPath);
      } catch (error) {
        console.error(
          `      ❌ Error extracting segment: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }

    if (segmentPaths.length === 0) {
      console.error("❌ No valid segments extracted");
      process.exit(1);
    }

    console.log(`\n   ✓ Extracted ${segmentPaths.length} segments\n`);

    // Concatenate segments
    console.log("🔗 Concatenating segments...");
    try {
      await concatenateAudio(
        segmentPaths,
        outputPath,
        segmentsDir,
        optimalBitrate,
      );
      console.log(`   ✓ Concatenated into: ${outputPath}\n`);
      console.log(`   📁 Segments saved in: ${segmentsDir}`);
      console.log(
        `   💡 You can manually delete the segments folder when done\n`,
      );
    } catch (error) {
      console.error(
        `   ❌ Error concatenating: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    console.log("✅ Extraction complete!");
    console.log(`   Total segments: ${segmentPaths.length}`);
    console.log(`   Total duration: ${secondsToTime(totalDuration)}`);
    console.log(`   Final bitrate: ${optimalBitrate} kbps`);
    console.log(`   Estimated size: ${estimatedSizeMB.toFixed(2)} MB`);
    console.log(`   Output: ${outputPath}`);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();
