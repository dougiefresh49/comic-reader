/**
 * Apply pending files in supabase/migrations/ to production with the
 * Supabase CLI, unattended (#699).
 *
 * Usage:
 *   pnpm db:push           dry run: lists what would apply, changes nothing
 *   pnpm db:push --apply   applies them (the lead only: LIVE_API_OK=1 in front)
 *
 * Both modes pass --include-all, so a file older than the newest applied
 * version still applies, and the CLI records each file under its own version.
 * The password goes to the CLI as PGPASSWORD in its environment, never in its
 * argv, and every line the CLI prints is passed through redact().
 */

import { spawn, spawnSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const PROJECT_REF = "sinmmbxrsbpjneccykwd";
// The Supavisor session-mode pooler. aws-1 is the one that answers for this
// project; aws-0 answers "tenant/user not found".
const POOLER_HOST = "aws-1-us-east-1.pooler.supabase.com";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PACKAGE = join(ROOT, "node_modules", "supabase");
const CLI_BIN = join(CLI_PACKAGE, "bin", "supabase");

const USAGE = `Usage:
  pnpm db:push           list the migrations that would apply (dry run)
  pnpm db:push --apply   apply them to production (LIVE_API_OK=1 in front)`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) {
  console.error(USAGE);
  process.exit(2);
}
const apply = args[0] === "--apply";

if (apply && process.env.DELEGATE === "1") {
  fail(
    "db:push --apply is blocked in a DELEGATE=1 session: only the lead applies migrations. Run the dry run (pnpm db:push) and hand the apply up in your report.",
  );
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!supabaseUrl) fail("NEXT_PUBLIC_SUPABASE_URL is not set in .env.");
const urlRef = new URL(supabaseUrl).hostname.split(".")[0];
if (urlRef !== PROJECT_REF) {
  fail(
    `NEXT_PUBLIC_SUPABASE_URL points at project ${urlRef}, not ${PROJECT_REF}, which this script pushes to. Stopping.`,
  );
}
const password = process.env.SUPABASE_DB_PASSWORD;
if (!password) fail("SUPABASE_DB_PASSWORD is not set in .env.");

const secrets = [...new Set([password, encodeURIComponent(password)])];
function redact(text: string): string {
  return secrets.reduce((out, s) => out.split(s).join("***"), text);
}

// The child's environment: no SUPABASE_DB_PASSWORD, so the only way the
// password reaches the CLI is the PGPASSWORD set below.
const baseEnv = { ...process.env };
delete baseEnv.SUPABASE_DB_PASSWORD;

// pnpm 10 skips the package's postinstall, so a fresh install has no binary.
// Run that postinstall ourselves: it downloads the release for this platform
// and checks it against the release's checksum file.
if (!existsSync(CLI_BIN)) {
  console.log(
    "Supabase CLI binary missing; fetching it with the package's postinstall.",
  );
  const fetched = spawnSync(process.execPath, ["scripts/postinstall.js"], {
    cwd: CLI_PACKAGE,
    env: baseEnv,
    stdio: "inherit",
  });
  if (fetched.status !== 0 || !existsSync(CLI_BIN)) {
    // A checksum mismatch throws after the binary is already extracted; do not
    // leave it for the next run to trust.
    rmSync(dirname(CLI_BIN), { recursive: true, force: true });
    fail("Could not fetch the Supabase CLI binary (see the output above).");
  }
}

const dbUrl = `postgresql://postgres.${PROJECT_REF}@${POOLER_HOST}:5432/postgres?sslmode=require`;
const cliArgs = [
  "db",
  "push",
  "--db-url",
  dbUrl,
  "--include-all",
  apply ? "--yes" : "--dry-run",
];

console.log(
  apply
    ? "Applying pending migrations to production..."
    : "Dry run: listing pending migrations, nothing is applied.",
);

const child = spawn(CLI_BIN, cliArgs, {
  cwd: ROOT,
  env: { ...baseEnv, PGPASSWORD: password },
  stdio: ["ignore", "pipe", "pipe"],
});

// Redact line by line, so a secret split across two chunks is still caught.
function relay(stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    const end = pending.lastIndexOf("\n");
    if (end === -1) return;
    out.write(redact(pending.slice(0, end + 1)));
    pending = pending.slice(end + 1);
  });
  stream.on("end", () => {
    if (pending) out.write(redact(pending));
  });
}
relay(child.stdout, process.stdout);
relay(child.stderr, process.stderr);

child.on("error", (err) =>
  fail(redact(`Could not run the Supabase CLI: ${err.message}`)),
);
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
