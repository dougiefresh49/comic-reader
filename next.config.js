/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.mjs";

/** @type {import("next").NextConfig} */
const config = {
  serverExternalPackages: ["@browserbasehq/stagehand"],
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

export default config;
