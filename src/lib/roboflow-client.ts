import { isDryRun } from "./fakes/dry-run";
import { fakeRoboflowResponse } from "./fakes/roboflow";

export type RoboflowImage = { type: "url" | "base64"; value: string };

/**
 * POST one image to a Roboflow workflow. Under DRY_RUN it returns a fixture
 * response and reads no key. Callers keep handling `ok`, `text()`, `json()`.
 */
export async function runRoboflowWorkflow(
  url: string,
  image: RoboflowImage,
): Promise<Response> {
  if (isDryRun()) return fakeRoboflowResponse(image);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.ROBOFLOW_API_KEY,
      inputs: { image },
    }),
  });
}
