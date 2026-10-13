/**
 * #897 evidence: the step-level Gemini retry (`withGeminiRetry`), its
 * transient-or-fatal classifier, the lookahead's step errors, and the in-step
 * Supabase retry. Free: no Gemini, DB or network call; every failure is a
 * thrown fake and every Gemini sleep is recorded, not waited.
 *
 * Usage: pnpm exec tsx scripts/check-gemini-retry.ts
 */
import assert from "node:assert/strict";
import { FatalError, RetryableError } from "workflow";
import {
  geminiRetryWait,
  isTransientGeminiError,
  withGeminiRetry,
  type GeminiRetryOptions,
} from "~/lib/llm-usage";
import { supabaseWithRetry } from "~/workflows/steps/read-retry";
import {
  embedFaceOrFatal,
  identifyFaceOrFatal,
  type GeminiRetry,
} from "~/workflows/steps/vision";

globalThis.fetch = () => Promise.reject(new Error("network blocked"));

/** Shaped like the SDK's `ApiError`: the body as the message, plus `status`. */
const apiError = (status: number, body?: string) =>
  Object.assign(
    new Error(
      body ?? `{"error":{"code":${status},"message":"Resource exhausted"}}`,
    ),
    { status },
  );
const err429 = () => apiError(429);
const retryDelayBody = (delay: string) =>
  `{"error":{"code":429,"message":"Resource exhausted","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"${delay}"}]}}`;

/** A fn that throws `errors` in order, then resolves "ok". */
function scripted(errors: Error[]) {
  const state = { calls: 0 };
  const fn = async () => {
    const err = errors[state.calls++];
    if (err) throw err;
    return "ok";
  };
  return { state, fn };
}

/** Options that record each wait instead of sleeping. */
function recorder() {
  const sleeps: number[] = [];
  const opts: GeminiRetryOptions = {
    label: "check",
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { sleeps, opts };
}

/** The step's retry deps, with the sleep recorded instead of waited. */
function fastGemini(sleeps: number[]): GeminiRetry {
  return {
    isTransientGeminiError,
    withGeminiRetry: <T>(fn: () => Promise<T>, o?: GeminiRetryOptions) =>
      withGeminiRetry(fn, {
        ...o,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
  };
}

let failed = 0;
async function check(name: string, body: () => Promise<void> | void) {
  try {
    await body();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

await check("(a) 429 twice, then ok: 3 calls, 2 sleeps <= 20000", async () => {
  const { state, fn } = scripted([err429(), err429()]);
  const { sleeps, opts } = recorder();
  assert.equal(await withGeminiRetry(fn, opts), "ok");
  assert.equal(state.calls, 3);
  assert.equal(sleeps.length, 2);
  for (const ms of sleeps) assert.ok(ms >= 0 && ms <= 20_000, `slept ${ms}`);
});

await check(
  "(b) a 429 wrapped as the cause of another Error is transient",
  () => {
    const cause = err429();
    const wrapped = new Error(`Gemini embedding failed: ${cause.message}`, {
      cause,
    });
    assert.equal(isTransientGeminiError(wrapped), true);
    assert.equal(
      isTransientGeminiError(new Error("Gemini embedding failed: no cause")),
      false,
    );
  },
);

await check("(c) 400: thrown at once, 1 call, no sleep", async () => {
  const bad = apiError(400, '{"error":{"code":400,"message":"bad image"}}');
  const { state, fn } = scripted([bad]);
  const { sleeps, opts } = recorder();
  await assert.rejects(withGeminiRetry(fn, opts), (e) => e === bad);
  assert.equal(state.calls, 1);
  assert.equal(sleeps.length, 0);
});

await check(
  "(d) 503 every time: rethrown unchanged after 4 calls",
  async () => {
    const errs = [503, 503, 503, 503, 503].map((s) => apiError(s));
    const { state, fn } = scripted(errs);
    const { sleeps, opts } = recorder();
    await assert.rejects(withGeminiRetry(fn, opts), (e) => e === errs[3]);
    assert.equal(state.calls, 4);
    assert.equal(sleeps.length, 3);
  },
);

await check(
  '(e) retryDelay "17s" waits 17000; "90s" clamps to 30000',
  async () => {
    assert.equal(
      geminiRetryWait(apiError(429, retryDelayBody("17s")), 1),
      17_000,
    );
    assert.equal(
      geminiRetryWait(apiError(429, retryDelayBody("90s")), 1),
      30_000,
    );
    const { fn } = scripted([apiError(429, retryDelayBody("17s"))]);
    const { sleeps, opts } = recorder();
    await withGeminiRetry(fn, opts);
    assert.deepEqual(sleeps, [17_000]);
  },
);

await check(
  "(f1) face naming: 429 on both keys that never clears ends in RetryableError",
  async () => {
    const sleeps: number[] = [];
    let runs = 0;
    const before = Date.now();
    const err = await identifyFaceOrFatal(
      () => {
        runs++;
        return Promise.reject(err429());
      },
      "primary",
      () => "fallback",
      "page-03",
      fastGemini(sleeps),
    ).catch((e: unknown) => e);
    assert.ok(RetryableError.is(err), `got ${String(err)}`);
    assert.match(
      (err as Error).message,
      /^Gemini face identification failed for page-03: \{"error":\{"code":429/,
    );
    const after = (err as RetryableError).retryAfter.getTime() - before;
    assert.ok(after >= 59_000 && after <= 61_000, `retryAfter +${after} ms`);
    assert.equal(runs, 8, "4 attempts, primary then fallback each");
    assert.equal(sleeps.length, 3);
  },
);

await check(
  "(f2) face naming: 429 then ok on the next attempt resolves",
  async () => {
    const sleeps: number[] = [];
    let runs = 0;
    const result = await identifyFaceOrFatal(
      (client: string) => {
        runs++;
        return runs <= 2 ? Promise.reject(err429()) : Promise.resolve(client);
      },
      "primary",
      () => "fallback",
      "page-03",
      fastGemini(sleeps),
    );
    assert.equal(result, "primary");
    assert.equal(runs, 3);
    assert.equal(sleeps.length, 1);
  },
);

await check("(f3) face naming: a 400 ends in FatalError, 1 run", async () => {
  const sleeps: number[] = [];
  let runs = 0;
  const err = await identifyFaceOrFatal(
    () => {
      runs++;
      return Promise.reject(apiError(400));
    },
    "primary",
    () => "fallback",
    "page-03",
    fastGemini(sleeps),
  ).catch((e: unknown) => e);
  assert.ok(err instanceof FatalError, `got ${String(err)}`);
  assert.match(err.message, /^Gemini face identification failed for page-03/);
  assert.equal(runs, 1);
  assert.equal(sleeps.length, 0);
});

await check(
  "(f4) face embedding: a wrapped 429 that never clears ends in RetryableError",
  async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const err = await embedFaceOrFatal(
      () => {
        calls++;
        const cause = err429();
        return Promise.reject(
          new Error(`Gemini embedding failed: ${cause.message}`, { cause }),
        );
      },
      "page-22",
      fastGemini(sleeps),
    ).catch((e: unknown) => e);
    assert.ok(RetryableError.is(err), `got ${String(err)}`);
    assert.match(
      (err as Error).message,
      /^face embedding failed for page-22: Gemini embedding failed: /,
    );
    assert.equal(calls, 4);
  },
);

await check(
  "(f5) face embedding: a 400 ends in FatalError, 1 call",
  async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const err = await embedFaceOrFatal(
      () => {
        calls++;
        const cause = apiError(400);
        return Promise.reject(
          new Error(`Gemini embedding failed: ${cause.message}`, { cause }),
        );
      },
      "page-22",
      fastGemini(sleeps),
    ).catch((e: unknown) => e);
    assert.ok(err instanceof FatalError, `got ${String(err)}`);
    assert.equal(calls, 1);
    assert.equal(sleeps.length, 0);
  },
);

await check(
  "(g) supabaseWithRetry: a 555 once, then ok, 2 attempts",
  async () => {
    let calls = 0;
    const data = await supabaseWithRetry("bubbles update", "page-17", () => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? { data: null, error: { message: "Internal server error." } }
          : { data: null, error: null },
      );
    });
    assert.equal(data, null);
    assert.equal(calls, 2);
  },
);

await check(
  "(g2) supabaseWithRetry: 3 failures end in FatalError",
  async () => {
    const err = await supabaseWithRetry("bubbles update", "page-17", () =>
      Promise.resolve({
        data: null,
        error: { message: "Internal server error." },
      }),
    ).catch((e: unknown) => e);
    assert.ok(err instanceof FatalError, `got ${String(err)}`);
    assert.equal(
      err.message,
      "bubbles update failed for page-17: Internal server error. (after 3 attempts)",
    );
  },
);

if (failed > 0) {
  console.log(`${failed} case(s) failed`);
  process.exit(1);
}
console.log("ok");
