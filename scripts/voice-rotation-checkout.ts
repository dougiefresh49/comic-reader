#!/usr/bin/env node

/**
 * Ingest pipeline wrapper: ensure all archived voices needed by this
 * book are restored before audio generation.
 *
 * Called as: pnpm voice-rotation-checkout -- --book <id> --issue <id>
 * Delegates to: pnpm voice-rotation -- --restore --book <id>
 */

import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

const args = process.argv.slice(2);
let book = "";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--book" && args[i + 1]) book = args[i + 1]!;
  else if (a?.startsWith("--book=")) book = a.split("=")[1]!;
}

if (!book) {
  console.error("❌ --book required");
  process.exit(1);
}

console.log(`🔄 Restoring archived voices for book "${book}"…`);
const child = spawn(
  "pnpm",
  ["voice-rotation", "--", "--restore", "--book", book],
  {
    stdio: "inherit",
    cwd: PROJECT_ROOT,
  },
);
child.on("close", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("❌ voice-rotation-checkout:", err.message);
  process.exit(1);
});
