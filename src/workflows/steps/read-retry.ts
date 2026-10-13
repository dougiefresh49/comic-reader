import { FatalError } from "workflow";

/**
 * A Supabase read made after a paid Gemini call retries here, inside the step,
 * up to 3 times, so a Workflow retry never pays for the Gemini call again
 * (#888). `query` rebuilds the request on each attempt; a rejection counts as
 * a failed attempt.
 */
export async function readWithRetry<T>(
  what: string,
  pageLabel: string,
  query: () => PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const result = await Promise.resolve()
      .then(query)
      .then(
        (r) => r,
        (e: unknown) => ({
          data: null,
          error: { message: e instanceof Error ? e.message : String(e) },
        }),
      );
    if (!result.error) return result.data as T;
    if (attempt === 3) {
      throw new FatalError(
        `${what} read failed for ${pageLabel}: ${result.error.message} (after 3 attempts)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
}
