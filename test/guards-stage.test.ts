import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertMcpUnchanged, assertNoAgentOverreach, fileFingerprint } from "../src/orchestrator/guards-stage.js";
import type { TaskdevContext } from "../src/taskdev/taskdev.js";
import type { RunState } from "../src/core/types.js";

/* Minimal git repo (mirrors units-git.test.ts) so assertNoAgentOverreach's real
 * git HEAD read can be exercised. */
function tempGitRepo(): { dir: string; head: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-guard-"));
  const run = (args: string[]): void => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "a\n");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "init"]);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  return { dir, head };
}

function commit(dir: string, contents: string, message: string): void {
  fs.writeFileSync(path.join(dir, "f.txt"), contents);
  const add = spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  const commitResult = spawnSync("git", ["commit", "-q", "-m", message], { cwd: dir, encoding: "utf8" });
  assert.equal(commitResult.status, 0, commitResult.stderr);
}

/* assertMcpUnchanged is the agent-MCP-surface guard. It was only covered
 * indirectly (via the viewer) and had no direct unit test; the standard HEAD
 * guard in assertNoAgentOverreach is exercised here too. */

test("assertMcpUnchanged: passes when fingerprints are unchanged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-mcp-"));
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, "{}");
  const state = { mcpHashes: { [file]: fileFingerprint(file) } } as RunState;
  assert.doesNotThrow(() => assertMcpUnchanged(state));
});

test("assertMcpUnchanged: throws when a tracked MCP file changed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-mcp-"));
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, "{}");
  const state = { mcpHashes: { [file]: fileFingerprint(file) } } as RunState;
  fs.writeFileSync(file, '{"x":1}');
  assert.throws(() => assertMcpUnchanged(state), /Overreach/);
});

test("assertMcpUnchanged: no-op when no mcpHashes recorded", () => {
  assert.doesNotThrow(() => assertMcpUnchanged({} as RunState));
});

test("assertNoAgentOverreach: passes when HEAD matches the baseline", () => {
  const { dir, head } = tempGitRepo();
  const state = { taskdev: { mode: "standard" }, baseCommit: head } as RunState;
  const context = { workspace: dir } as unknown as TaskdevContext;
  assert.doesNotThrow(() => assertNoAgentOverreach(state, context));
});

test("assertNoAgentOverreach: throws when HEAD moved from the baseline", () => {
  const { dir, head } = tempGitRepo();
  commit(dir, "b\n", "move");
  const state = { taskdev: { mode: "standard" }, baseCommit: head } as RunState;
  const context = { workspace: dir } as unknown as TaskdevContext;
  assert.throws(() => assertNoAgentOverreach(state, context), /Overreach/);
});

test("assertNoAgentOverreach: uses baselineCommit in replay mode", () => {
  const { dir, head } = tempGitRepo();
  const state = { taskdev: { mode: "replay", baselineCommit: head } } as RunState;
  const context = { workspace: dir } as unknown as TaskdevContext;
  assert.doesNotThrow(() => assertNoAgentOverreach(state, context));
});
