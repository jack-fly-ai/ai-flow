import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireRunLock, isProcessAlive, readRunLock } from "../src/state/lock.js";
import { waitUntil } from "./helpers/test-utils.js";

/* The run lock is the core mutual-exclusion primitive; these tests lock the
 * observability surface (readRunLock) and the heartbeat lifecycle without a real
 * git repo or a live agent. */

test("readRunLock: null when there is no lock file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-lock-"));
  try {
    assert.equal(readRunLock(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readRunLock: parses a legacy pid-only lock (no timestamps)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-lock-"));
  try {
    fs.writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ pid: 4242 }));
    const info = readRunLock(dir);
    assert.ok(info);
    assert.equal(info.pid, 4242);
    assert.equal(info.uid, null);
    assert.equal(info.startedAt, null);
    assert.equal(info.heartbeatAt, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readRunLock: parses a full lock with startedAt/heartbeatAt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-lock-"));
  try {
    fs.writeFileSync(
      path.join(dir, "run.lock"),
      JSON.stringify({ pid: 99, uid: 1000, startedAt: "2026-01-01T00:00:00.000Z", heartbeatAt: "2026-01-01T00:05:00.000Z" }),
    );
    const info = readRunLock(dir);
    assert.ok(info);
    assert.equal(info.pid, 99);
    assert.equal(info.uid, 1000);
    assert.equal(info.startedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(info.heartbeatAt, "2026-01-01T00:05:00.000Z");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readRunLock: a corrupted lock file reads as null (not a throw)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-lock-"));
  try {
    fs.writeFileSync(path.join(dir, "run.lock"), "{ not json");
    assert.equal(readRunLock(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("acquire + release: lock exists while held, gone after release", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-lock-"));
  try {
    const handle = await acquireRunLock(dir);
    const held = readRunLock(dir);
    assert.ok(held);
    assert.equal(held.pid, process.pid);
    assert.ok(held.startedAt);
    assert.ok(held.heartbeatAt);
    handle.release();
    assert.equal(readRunLock(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("heartbeat: a held lock's heartbeatAt advances while the holder lives", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-lock-"));
  try {
    // A tiny interval so a tick is guaranteed within the wait; RUN_LOCK_HEARTBEAT_MS
    // is the production default, here overridden via the test seam.
    const handle = await acquireRunLock(dir, { heartbeatMs: 10 });
    const before = readRunLock(dir);
    assert.ok(before);
    const startedAt = before.startedAt;
    // Wait long enough for several ticks.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const after = readRunLock(dir);
    assert.ok(after);
    assert.equal(after.startedAt, startedAt, "startedAt is immutable for the lock's lifetime");
    assert.notEqual(after.heartbeatAt, startedAt, "heartbeatAt advanced while the holder lived");
    handle.release();
    assert.equal(readRunLock(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* The run lock's orphan reaper kills a lingering agent recorded in agent.pid.
 * The pid-reuse guard (expectedAgentBin + /proc cmdline) is what keeps a
 * RECYCLED pid — the number now belonging to an unrelated process — from being
 * signalled: killAgentGroup targets the whole process GROUP, so a false
 * positive would take down innocent processes. */

test("orphan reaper: a recorded pid that is NOT the expected agent binary is left alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-lock-"));
  // A live, verifiable "reused pid": sleep's cmdline basename is "sleep".
  const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    fs.writeFileSync(path.join(dir, "agent.pid"), String(bystander.pid));
    const handle = await acquireRunLock(dir, { expectedAgentBin: "definitely-not-sleep" });
    // The reaper waits out its SIGTERM grace window when it does act; give a
    // matching window to (not) act before judging.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(isProcessAlive(bystander.pid!), true, "a pid reused by an unrelated process must never be signalled");
    handle.release();
  } finally {
    bystander.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("orphan reaper: a recorded pid that IS the expected agent binary is reaped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-lock-"));
  const orphan = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    fs.writeFileSync(path.join(dir, "agent.pid"), String(orphan.pid));
    const handle = await acquireRunLock(dir, { expectedAgentBin: "sleep" });
    await waitUntil(() => !isProcessAlive(orphan.pid!), {
      timeoutMs: 6000,
      message: "a recorded orphan agent (matching binary) must be reaped on the next acquire",
    });
    handle.release();
  } finally {
    orphan.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
