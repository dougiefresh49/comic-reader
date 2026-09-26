// HTTP Basic Auth for admin, the review editor, and the paid review actions.
// Family-only stopgap until Supabase Auth lands (#120).
//
// Runs in the Edge middleware runtime as well as Node, so no Node-only
// imports here (atob, not Buffer).
//
// Enforcement: when ADMIN_USERNAME and ADMIN_PASSWORD are both set, a
// matching Authorization header is required, locally and deployed. When
// either is unset, deployments (VERCEL_ENV set) get a 503 and local dev
// passes through.

export type AdminAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; message: string };

const REALM = "comic-reader admin";

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function checkAdminAuth(authorization: string | null): AdminAuthResult {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    if (process.env.VERCEL_ENV) {
      return {
        ok: false,
        status: 503,
        message: "ADMIN_USERNAME / ADMIN_PASSWORD not configured",
      };
    }
    return { ok: true };
  }

  if (authorization?.startsWith("Basic ")) {
    try {
      const decoded = atob(authorization.slice("Basic ".length));
      const sep = decoded.indexOf(":");
      if (sep !== -1) {
        const userOk = safeEqual(decoded.slice(0, sep), username);
        const passOk = safeEqual(decoded.slice(sep + 1), password);
        if (userOk && passOk) return { ok: true };
      }
    } catch {
      /* malformed base64: fall through to 401 */
    }
  }

  return { ok: false, status: 401, message: "Authentication required" };
}

/** The HTTP response for a failed check: 401 carries the Basic challenge. */
export function adminAuthFailure(
  result: Extract<AdminAuthResult, { ok: false }>,
): Response {
  return new Response(result.message, {
    status: result.status,
    headers:
      result.status === 401
        ? { "WWW-Authenticate": `Basic realm="${REALM}"` }
        : undefined,
  });
}
