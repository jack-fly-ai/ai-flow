import assert from "node:assert/strict";
import { test } from "node:test";
import { StageError } from "../src/core/errors.js";
import { unscopedPackPolicy } from "../src/adapters/scope.js";
import { genericAdapter, getAdapter, viewersAdapter } from "../src/adapters/index.js";
import type { AiFlowConfig, Change } from "../src/core/types.js";
import { withEnv } from "./helpers/test-utils.js";

/* unscopedPackPolicy is the pure policy behind the generic (no-scope-guard)
 * adapter's allow/warn/reject decision. It had no direct test even though its
 * own comment calls it unit-testable; the orchestrator (phases.ts) is its only
 * caller. */

function config(patch: Partial<AiFlowConfig> = {}): AiFlowConfig {
  return { runner: { command: ["fake-agent", "{promptFile}"] }, ...patch };
}

test("unscopedPackPolicy: a dedicated module adapter is always allowed", () => {
  assert.equal(unscopedPackPolicy(viewersAdapter.module, config()), "allow");
  assert.equal(unscopedPackPolicy(viewersAdapter.module, config({ advanced: { strictUnscoped: true } })), "allow");
});

test("unscopedPackPolicy: the generic pack warns by default", () => {
  assert.equal(unscopedPackPolicy(genericAdapter.module, config()), "warn");
  assert.equal(unscopedPackPolicy(genericAdapter.module, undefined), "warn");
});

test("unscopedPackPolicy: taskdev.allowUnscoped acknowledges the risk (allow)", () => {
  assert.equal(unscopedPackPolicy(genericAdapter.module, config({ taskdev: { allowUnscoped: true } })), "allow");
  /* The explicit acknowledgement wins over strictUnscoped: it is the operator's
   * conscious, recorded choice — a stale strict flag must not override it. */
  assert.equal(
    unscopedPackPolicy(genericAdapter.module, config({ taskdev: { allowUnscoped: true }, advanced: { strictUnscoped: true } })),
    "allow",
  );
});

test("unscopedPackPolicy: advanced.strictUnscoped refuses an unacknowledged generic pack", () => {
  assert.equal(unscopedPackPolicy(genericAdapter.module, config({ advanced: { strictUnscoped: true } })), "reject");
});

/* The generic adapter is the "run end-to-end before the adapter is written"
 * fallback. Its guards are intentionally no-ops and its pack check is a SKIPPED
 * warning — assert that contract so a later change that makes it silently pass
 * real verification is caught. */
test("genericAdapter: no-op scope guards and a SKIPPED pack check", async () => {
  assert.doesNotThrow(() => genericAdapter.assertPhase2Scope([]));
  assert.doesNotThrow(() => genericAdapter.assertPhase3Scope("a", "b"));
  const out = await genericAdapter.check({ worktree: ".", changedFiles: [], logFile: "/dev/null" });
  assert.equal(out.passed, true);
  assert.ok(out.output.includes("SKIPPED"));
});

test("getAdapter: warns once when an unknown pack falls back to generic", () => {
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown): void => {
    warned.push(String(message));
  };
  try {
    const unique = `unknown-pack-${Math.random().toString(36).slice(2)}`;
    const adapter = getAdapter(unique);
    assert.equal(adapter, genericAdapter);
    assert.ok(warned.some((m) => m.includes(unique) && m.includes("genericAdapter")));
  } finally {
    console.warn = original;
  }
});

test("getAdapter: does not warn for the built-in viewers adapter", () => {
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown): void => {
    warned.push(String(message));
  };
  try {
    assert.equal(getAdapter("viewers"), viewersAdapter);
    assert.ok(!warned.some((m) => m.includes("genericAdapter")));
  } finally {
    console.warn = original;
  }
});

/* The generic adapter has no allow-list scope guard — its mechanical backstop
 * is the operator-configured deny-list (taskdev.forbidPaths, exported by the
 * pipeline as TASK_FORBID_PATHS). Without it the only backstop for an unscoped
 * pack is the gate-4 human audit. */
test("genericAdapter.assertPhase2Scope: TASK_FORBID_PATHS denies matching changes", () => {
  const changes: Change[] = [
    { path: ".github/workflows/ci.yml", status: "M" },
    { path: "src/app.ts", status: "M" },
  ];
  withEnv({ TASK_FORBID_PATHS: ".github/,infrastructure/" }, () => {
    assert.throws(
      () => genericAdapter.assertPhase2Scope(changes),
      (err: unknown) =>
        err instanceof StageError &&
        /forbidden paths/.test(err.message) &&
        /ci\.yml/.test(err.message) &&
        /taskdev\.forbidPaths/.test(err.message),
    );
  });
});

test("genericAdapter.assertPhase2Scope: an exact (file) prefix match is also denied", () => {
  const changes: Change[] = [{ path: "VERSION", status: "M" }];
  withEnv({ TASK_FORBID_PATHS: "VERSION" }, () => {
    assert.throws(() => genericAdapter.assertPhase2Scope(changes), (err: unknown) => err instanceof StageError);
  });
});

test("genericAdapter.assertPhase2Scope: passes when no forbid prefix matches", () => {
  const changes: Change[] = [{ path: "src/app.ts", status: "M" }];
  withEnv({ TASK_FORBID_PATHS: ".github/,infrastructure/" }, () => {
    assert.doesNotThrow(() => genericAdapter.assertPhase2Scope(changes));
  });
});

test("genericAdapter.assertPhase2Scope: unset env is a no-op (deny-list off by default)", () => {
  assert.doesNotThrow(() => genericAdapter.assertPhase2Scope([{ path: ".github/x", status: "M" }]));
});
