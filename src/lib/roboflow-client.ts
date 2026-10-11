import { createHash } from "crypto";
import { isDryRun } from "./fakes/dry-run";
import { fakeRoboflowResponse } from "./fakes/roboflow";

export type RoboflowImage = { type: "url" | "base64"; value: string };

/**
 * Tells two keys apart in a log without printing either (#375). The sha256
 * prefix matches the key id the Roboflow dashboard and API list.
 */
function keyFingerprint(key: string | undefined): string {
  if (!key) return "unset";
  const sha = createHash("sha256").update(key).digest("hex").slice(0, 8);
  const untrimmed = key.trim() === key ? "" : " untrimmed";
  return `len=${key.length} sha256=${sha} prefix=${key.slice(0, 4)}${untrimmed}`;
}

/**
 * POST one image to a Roboflow workflow. Under DRY_RUN it returns a fixture
 * response and reads no key. Callers keep handling `ok`, `text()`, `json()`.
 */
export async function runRoboflowWorkflow(
  url: string,
  image: RoboflowImage,
): Promise<Response> {
  if (isDryRun()) return fakeRoboflowResponse(image);
  const apiKey = process.env.ROBOFLOW_API_KEY;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, inputs: { image } }),
  });
  if (res.status === 401 || res.status === 403) {
    console.warn(
      `[roboflow] HTTP ${res.status} from ${new URL(url).pathname}, key ${keyFingerprint(apiKey)}`,
    );
  }
  return res;
}
