import { NextResponse, type NextRequest } from "next/server";
import { adminAuthFailure, checkAdminAuth } from "~/lib/admin-auth";

// HTTP Basic Auth on admin, the review editor, apply-fixes and the
// episode render route. The rules live in src/lib/admin-auth.ts.

export function middleware(req: NextRequest) {
  const result = checkAdminAuth(req.headers.get("authorization"));
  if (result.ok) return NextResponse.next();
  return adminAuthFailure(result);
}

export const config = {
  matcher: [
    "/admin/:path*",
    "/api/admin/:path*",
    "/api/apply-fixes/:path*",
    "/episode-render/:path*",
  ],
};
