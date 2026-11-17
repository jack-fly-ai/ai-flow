/* Shared test utilities: condition waits and environment custody.
 *
 * `waitUntil` polls the actual precondition with a bounded deadline, so a test
 * proceeds as soon as the fixture is ready or fails with the real reason.
 * `withEnv` restores overrides even when the body throws. */

/** Fixture processes come up in milliseconds; 5s is a generous margin for a
 * loaded machine without letting a broken fixture hang the suite. */
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_INTERVAL_MS = 25;

/**
 * Poll `condition` until it returns true, or throw with `message` after
 * `timeoutMs` (default 5s). The error message is the test's evidence: it
 * says WHAT never became ready, not "expected rejection".
 */
export async function waitUntil(
  condition: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(options.message ?? `condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Run `fn` with `vars` applied to process.env, restoring the previous values
 * afterwards — including when `fn` throws. A value of `undefined` DELETES the
 * variable (the correct restore for one that was not set before).
 */
export async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const previous: Array<[string, string | undefined]> = Object.keys(vars).map((key) => [key, process.env[key]]);
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
