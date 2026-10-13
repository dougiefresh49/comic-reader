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
    // The SDK throws a plain Error here, so the message is all there is to match.
    if (
      err instanceof Error &&
      err.message.includes("HTTP 404") &&
      err.message.includes("Deployment not found")
    ) {
      return true;
    }
    throw err;
  }
}
