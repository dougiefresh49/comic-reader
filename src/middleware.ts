import { NextResponse, type NextRequest } from "next/server";

// Auth disabled — basic auth browser dialog is more annoying than helpful
// during active development. Re-enable before any public exposure.
//
// Original: HTTP Basic Auth protecting /admin/* and /api/admin/* routes
// using ADMIN_USERNAME + ADMIN_PASSWORD env vars.

export function middleware(_req: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
