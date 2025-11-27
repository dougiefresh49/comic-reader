import youtubedl from "youtube-dl-exec";
import fs from "fs";
import path from "path";

// --- CONFIGURATION ---
// 1. Paste the YouTube URL you want to test
const YOUTUBE_URL = "https://www.youtube.com/watch?v=OPgQr_WC_Zk"; // Your TMNT clip

// 2. Define your output folder and file name
const OUTPUT_DIR = "./audio-test-files";
const OUTPUT_FILENAME = "test_audio.mp3";
// --- END CONFIGURATION ---

const outputPath = path.join(OUTPUT_DIR, OUTPUT_FILENAME);

/**
 * Downloads the audio-only stream from a YouTube URL using yt-dlp.
 * @param {string} url - The YouTube video URL.
 * @param {string} filepath - The location to save the .mp3 file.
 */
async function downloadAudio(url, filepath) {
  console.log(`Starting download for: ${url}`);

  // Ensure the output directory exists
  try {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      console.log(`Created directory: ${OUTPUT_DIR}`);
    }
  } catch (err) {
    console.error(`Failed to create directory: ${err}`);
    return;
  }

  // 1. Call the youtube-dl-exec library directly
  try {
    console.log("Spawning yt-dlp process...");

    // This calls the library's JS wrapper, which handles finding
    // the yt-dlp binary much more reliably than npx.
    const output = await youtubedl(url, {
      extractAudio: true,
      audioFormat: "mp3",
      format: "bestaudio",
      output: filepath,
    });

    console.log("yt-dlp output:", output);

    console.log(`\n✅ Download Complete!`);
    console.log(`File saved to: ${filepath}`);
    console.log(
      `\nYou can now upload this file to the ElevenLabs Scribe UI to test the pruning workflow.`,
    );
  } catch (err) {
    console.error(`\n❌ Download Error:`);
    console.error(err);
  }
}

// --- Run the script ---
downloadAudio(YOUTUBE_URL, outputPath);
