import "server-only";
import { getWorld } from "workflow/runtime";
import { HookNotFoundError } from "workflow/errors";

/**
 * The run holding a gate hook token, or null when no hook holds it. Reads the
 * hook straight from the World: `getHookByToken` also fetches the run's
 * encryption key to decrypt metadata, which fails once the run's deployment
 * is deleted (#883), and the routes only need the runId.
 */
export async function findGateHook(
  token: string,
): Promise<{ runId: string } | null> {
  try {
    const hook = await getWorld().hooks.getByToken(token);
    return { runId: hook.runId };
  } catch (err) {
    if (HookNotFoundError.is(err)) return null;
    throw err;
  }
}

/**
 * Whether the run's Vercel deployment no longer exists, so the run can never
 * resume (#883). Only the run-key fetch's 404 "Deployment not found" counts;
 * a World without run keys (the local world) answers false, and any other
 * error is rethrown.
 */
export async function isDeploymentGone(runId: string): Promise<boolean> {
  const world = getWorld();
  const run = await world.runs.get(runId);
  try {
    await world.getEncryptionKeyForRun?.(run);
    return false;
  } catch (err) {
    // The SDK throws a plain Error here, so the message is all there is to
    // match: its own status line for this run, then the API's JSON body. A
    // body quoting a 404 under another status must not count.
    const status = `Failed to fetch run key for ${run.runId} (deployment ${run.deploymentId}): HTTP 404 `;
    const message = err instanceof Error ? err.message : "";
    const bodyAt = message.indexOf(" — ", status.length);
    if (message.startsWith(status) && bodyAt !== -1) {
      try {
        const body = JSON.parse(message.slice(bodyAt + 3)) as {
          error?: { code?: unknown };
        };
        if (body.error?.code === "not_found") return true;
      } catch {
        // Not the API's JSON body, so not the answer this check reads.
      }
    }
    throw err;
  }
}
