/**
 * The admin check every admin server action makes first (#480). Next routes
 * an action by its id, not the page path, so the middleware's Basic Auth
 * does not cover it; this does. Throws the auth message on failure.
 * Needs a request: call it from an action or a page render, never a script.
 */
import "server-only";
import { headers } from "next/headers";
import { checkAdminAuth } from "~/lib/admin-auth";

export async function requireAdmin() {
  const auth = checkAdminAuth((await headers()).get("authorization"));
  if (!auth.ok) throw new Error(auth.message);
}
