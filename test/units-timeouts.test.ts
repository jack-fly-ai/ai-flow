import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StageError } from "../src/core/errors.js";
import { createTarPackage } from "../src/delivery/package.js";
import { runTool } from "../src/taskdev/taskdev.js";
import { withEnv } from "./helpers/test-utils.js";

/* The pipeline process's own blocking external calls (control-plane tool
 * spawns, the packaging tar) run OUTSIDE the run watchdog's reach — the
 * watchdog signals the agent, never this process. Each must carry a default
 * ceiling and report a kill as what it is. Both ceilings are env-overridable
 * and read per call, which is what makes them testable here. */

function tempSkillDirWithSleepingTool(): string {
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-tool-to-"));
  const toolsDir = path.join(skillDir, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  const tool = path.join(toolsDir, "task-progress");
  fs.writeFileSync(tool, "#!/bin/sh\nsleep 30\n");
  fs.chmodSync(tool, 0o755);
  return skillDir;
}

test("runTool: a hung control-plane tool is killed at the ceiling (explicit and env default)", async () => {
  const skillDir = tempSkillDirWithSleepingTool();
  try {
    // An explicit ceiling wins — and the kill must actually BOUND the wait. A
    // it to the grandchild's full lifetime despite the kill.
    let started = Date.now();
    await assert.rejects(
      () => runTool({ skillDir, tool: "task-progress", args: ["show", "TASK1"], timeoutMs: 300 }),
      (err: unknown) => err instanceof StageError && err.kind === "startup" && /task-progress timed out after 300ms/.test(err.message),
    );
    assert.ok(Date.now() - started < 3000, `the kill must bound the wait (took ${Date.now() - started}ms)`);

    // With no explicit option the ceiling comes from the environment, read per
    // call (the module-load-time read would make this untestable).
    started = Date.now();
    await withEnv({ AI_FLOW_TOOL_TIMEOUT_MS: "250" }, async () => {
      await assert.rejects(
        () => runTool({ skillDir, tool: "task-progress", args: ["show", "TASK1"] }),
        (err: unknown) => err instanceof StageError && /task-progress timed out after 250ms/.test(err.message),
      );
    });
    assert.ok(Date.now() - started < 3000, `the env-default kill must bound the wait (took ${Date.now() - started}ms)`);
  } finally {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
});

test("createTarPackage: a hung tar is killed at the ceiling with a plain error", () => {
  // spawnSync("tar") resolves through PATH, so a fake `tar` that sleeps stands
  // in for a stalled ~/task mount.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-tar-to-"));
  const worktree = path.join(root, "wt");
  const binDir = path.join(root, "bin");
  const destinationDir = path.join(root, "pkg");
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.writeFileSync(path.join(worktree, "a.txt"), "a\n");
  const fakeTar = path.join(binDir, "tar");
  fs.writeFileSync(fakeTar, "#!/bin/sh\nsleep 30\n");
  fs.chmodSync(fakeTar, 0o755);
  const prevPath = process.env.PATH;
  const prevTimeout = process.env.AI_FLOW_TAR_TIMEOUT_MS;
  try {
    process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ""}`;
    withEnv({ AI_FLOW_TAR_TIMEOUT_MS: "300" }, () => {
      assert.throws(
        () => createTarPackage({ worktree, paths: ["a.txt"], id: "TASK1", destinationDir }),
        (err: unknown) => err instanceof StageError && err.kind === "finished" && /tar packaging timed out after 300ms/.test(err.message),
        "a timeout names the ceiling and the likely cause, not a bare 'tar failed'",
      );
    });
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevTimeout === undefined) delete process.env.AI_FLOW_TAR_TIMEOUT_MS;
    else process.env.AI_FLOW_TAR_TIMEOUT_MS = prevTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createTarPackage: a healthy tar still tolerates exit code 1 (file changed as we read it)", () => {
  // The timeout must not turn tar's documented warning exit into a failure.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-tar-ok-"));
  const worktree = path.join(root, "wt");
  const destinationDir = path.join(root, "pkg");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, "a.txt"), "a\n");
  try {
    const { tarPath } = createTarPackage({ worktree, paths: ["a.txt"], id: "TASK1", destinationDir });
    assert.ok(fs.existsSync(tarPath), "the archive is written");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runTool: a healthy tool still returns its output under the default ceiling", async () => {
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-tool-ok-"));
  const toolsDir = path.join(skillDir, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  const tool = path.join(toolsDir, "task-progress");
  fs.writeFileSync(tool, "#!/bin/sh\necho 'phase: 2'\n");
  fs.chmodSync(tool, 0o755);
  try {
    const result = await runTool({ skillDir, tool: "task-progress", args: ["show", "TASK1"] });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /phase: 2/);
  } finally {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
});
