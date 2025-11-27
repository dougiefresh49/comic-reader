import youtubedl from "youtube-dl-exec";
import fs from "fs";
import path from "path";

// --- CONFIGURATION ---
// 1. Paste the YouTube URL you want to test
const YOUTUBE_URL = "https://www.youtube.com/watch?v=OPgQr_WC_Zk"; // Your TMNT clip

// 2. Define your output folder and file name
const OUTPUT_DIR = "./video-test-files"; // New folder for video
const OUTPUT_FILENAME = "test_video.mp4";
// --- END CONFIGURATION ---

const outputPath = path.join(OUTPUT_DIR, OUTPUT_FILENAME);

/**
 * Downloads the best quality MP4 video from a YouTube URL using yt-dlp.
 * @param {string} url - The YouTube video URL.
 * @param {string} filepath - The location to save the .mp4 file.
 */
async function downloadVideo(url, filepath) {
  console.log(`Starting video download for: ${url}`);

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

    // This calls the library's JS wrapper.
    // Flags:
    // -f 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
    //   This tries to find the best MP4 video and best M4A audio and "mux" (combine) them.
    //   If that fails, it falls back to the single best file with an .mp4 extension.
    // -o: The output path.
    const output = await youtubedl(url, {
      format: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      output: filepath,
    });

    console.log("yt-dlp output:", output);

    console.log(`\n✅ Download Complete!`);
    console.log(`File saved to: ${filepath}`);
    console.log(
      `\nYou can now drag this MP4 file into Descript to test the pruning workflow.`,
    );
  } catch (err) {
    console.error(`\n❌ Download Error:`);
    console.error(err);
  }
}

// --- Run the script ---
downloadVideo(YOUTUBE_URL, outputPath);
