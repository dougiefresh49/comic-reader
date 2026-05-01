import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    ROBOFLOW_API_KEY: z.string(),
    ROBOFLOW_WORKFLOW_URL: z.string(),
    /** Panel-detection workflow (serverless); override if Roboflow changes the deploy URL. */
    ROBOFLOW_PANEL_WORKFLOW_URL: z
      .string()
      .url()
      .default(
        "https://serverless.roboflow.com/fresh-space/workflows/find-comic-panel-v1",
      ),
    /** Combined panel + bubble + full-page SAM3 segmentation workflow.
     *  v2 (per-panel SAM3) is currently broken upstream (dynamic_crop block bug
     *  reported 2026-05-01); v3 runs SAM3 once on the full page and we map
     *  polygons to panel-local coords ourselves in extract-foreground-masks. */
    ROBOFLOW_SAM3_WORKFLOW_URL: z
      .string()
      .url()
      .default(
        "https://serverless.roboflow.com/infer/workflows/fresh-space/comic-page-analyzer-v3-full-page-sam3",
      ),
    GEMINI_API_KEY: z.string(),
    GEMINI_API_KEY_2: z.string(),
    ELEVENLABS_API_KEY: z.string(),
    VENICE_API_KEY: z.string(),
    FREESOUND_API_KEY: z.string().optional(),
    FREESOUND_CLIENT_ID: z.string().optional(),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    // NEXT_PUBLIC_CLIENTVAR: z.string(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    LOG_LEVEL: process.env.LOG_LEVEL,
    ROBOFLOW_API_KEY: process.env.ROBOFLOW_API_KEY,
    ROBOFLOW_WORKFLOW_URL: process.env.ROBOFLOW_WORKFLOW_URL,
    ROBOFLOW_PANEL_WORKFLOW_URL: process.env.ROBOFLOW_PANEL_WORKFLOW_URL,
    ROBOFLOW_SAM3_WORKFLOW_URL: process.env.ROBOFLOW_SAM3_WORKFLOW_URL,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_API_KEY_2: process.env.GEMINI_API_KEY_2,
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
    VENICE_API_KEY: process.env.VENICE_API_KEY,
    FREESOUND_API_KEY: process.env.FREESOUND_API_KEY,
    FREESOUND_CLIENT_ID: process.env.FREESOUND_CLIENT_ID,
    // NEXT_PUBLIC_CLIENTVAR: process.env.NEXT_PUBLIC_CLIENTVAR,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
