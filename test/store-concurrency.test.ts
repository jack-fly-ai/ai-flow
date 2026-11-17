import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  ConcurrentStateError,
  createState,
  readStateOrNull,
  writeState,
} from "../src/state/store.js";

/* The state.json writer guards against lost updates with an optimistic rev: a
 * write whose in-memory rev is behind the on-disk rev is refused, not clobbered.
 * These tests prove that guard both fires and that the retry path converges —
 * the property that keeps two concurrent processes (the pipeline vs. the viewer
 * Stop, or two retry spawns) from losing each other's update. */

test("store: writeState refuses a stale rev so a concurrent write is not lost", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-"));
  try {
    writeState(dir, createState("1", dir, "base")); // rev -> 1
    const a = readStateOrNull(dir); // process A's snapshot, rev 1
    const b = readStateOrNull(dir); // process B's snapshot, rev 1
    writeState(dir, a!); // A wins: on-disk rev -> 2
    // B's write carries rev 1, which is now stale: refuse, never overwrite.
    assert.throws(() => writeState(dir, b!), (err) => err instanceof ConcurrentStateError);
    // B recovers by re-reading and re-writing: rev -> 3.
    writeState(dir, readStateOrNull(dir)!);
    assert.equal(readStateOrNull(dir)!.rev, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store: two processes concurrently calling withStateUpdate never lose an update", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-"));
  try {
    writeState(dir, createState("1", dir, "base")); // rev -> 1
    // A throwaway worker that does N no-op withStateUpdate increments (each a
    // successful write advances rev by exactly 1). Two of them racing on the
    // O_EXCL lock + rev guard must still leave rev advanced by 2N, or a lost
    // update occurred.
    const storeUrl = pathToFileURL(path.resolve("src/store.ts")).href;
    const worker = path.join(os.tmpdir(), `scw-${process.pid}.ts`);
    fs.writeFileSync(
      worker,
      `import { withStateUpdate } from ${JSON.stringify(storeUrl)};\n` +
        `const dir = process.argv[2]; const n = Number(process.argv[3]);\n` +
        `(async () => { for (let i = 0; i < n; i++) await withStateUpdate(dir, () => {}); })()` +
        `.then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });\n`,
    );
    const n = 15;
    const run = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", worker, dir, String(n)], { stdio: "ignore" });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
      });
    await Promise.all([run(), run()]);
    // 1 initial + 2 * 15 increments, each a successful write => rev 31.
    assert.equal(readStateOrNull(dir)!.rev, 1 + 2 * n);
    fs.rmSync(worker, { force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
