/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.mjs";
import { withWorkflow } from "workflow/next";

/** @type {import("next").NextConfig} */
const config = {
  serverExternalPackages: ["@browserbasehq/stagehand", "workflow"],
  images: {
    // Comic pages are already WebP and served from Supabase Storage's CDN.
    // unoptimized: true bypasses Vercel's image optimizer entirely so we
    // don't double-cache (Vercel + Supabase) and don't burn the image-
    // optimization transform quota. See specs/features/data-hosting/
    // image-optimization-future.md for the long-term plan (Supabase
    // Image Transformations + custom loader).
    unoptimized: true,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
      },
    ],
  },
};

const workflowConfig = withWorkflow(config);

// withWorkflow writes its loader rules to the top-level `turbopack` key,
// which Next 15.3 introduced. Next 15.2 reads them from `experimental.turbo`.
/** @type {typeof workflowConfig} */
export default async function nextConfig(phase, ctx) {
  const { turbopack, ...rest } = await workflowConfig(phase, ctx);
  return { ...rest, experimental: { ...rest.experimental, turbo: turbopack } };
}
