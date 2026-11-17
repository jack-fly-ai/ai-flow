import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ErrorCode, StageError } from "../src/core/errors.js";
import { verifySkillContract } from "../src/taskdev/taskdev-contract.js";

function makeSkillDir(tools: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-contract-"));
  const toolsDir = path.join(root, "skills", "task-dev", "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  for (const t of tools) {
    const p = path.join(toolsDir, t);
    fs.writeFileSync(p, "#!/bin/sh\n");
    fs.chmodSync(p, 0o755);
  }
  return root;
}

test("contract: missing tools directory fails fast as a startup error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-contract-"));
  assert.throws(() => verifySkillContract(path.join(root, "skills", "task-dev")), (err) => {
    return err instanceof StageError && err.kind === "startup" && err.code === ErrorCode.SKILL_NOT_FOUND;
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test("contract: empty tools directory lists all three missing tools", () => {
  const root = makeSkillDir([]);
  const skillDir = path.join(root, "skills", "task-dev");
  assert.throws(() => verifySkillContract(skillDir), (err) => {
    return (
      err instanceof StageError &&
      err.kind === "startup" &&
      err.code === ErrorCode.SKILL_MISSING_TOOLS &&
      /task-workspace, task-progress, task-replay/.test(err.message)
    );
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test("contract: a partially-populated tools directory names the missing ones", () => {
  const root = makeSkillDir(["task-workspace"]);
  const skillDir = path.join(root, "skills", "task-dev");
  assert.throws(() => verifySkillContract(skillDir), (err) => {
    return err instanceof StageError && err.code === ErrorCode.SKILL_MISSING_TOOLS && /task-progress, task-replay/.test(err.message);
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test("contract: a fully-populated tools directory passes", () => {
  const root = makeSkillDir(["task-workspace", "task-progress", "task-replay"]);
  const skillDir = path.join(root, "skills", "task-dev");
  assert.doesNotThrow(() => verifySkillContract(skillDir));
  fs.rmSync(root, { recursive: true, force: true });
});

test("contract: a non-executable tool fails fast (no silent mid-pipeline break)", () => {
  const root = makeSkillDir(["task-workspace", "task-progress", "task-replay"]);
  const toolsDir = path.join(root, "skills", "task-dev", "tools");
  // Drop the +x bit on one tool; the check must now reject at startup rather
  // than warn and let the pipeline crash when the tool is spawned.
  fs.chmodSync(path.join(toolsDir, "task-progress"), 0o644);
  assert.throws(() => verifySkillContract(path.join(root, "skills", "task-dev")), (err) => {
    return err instanceof StageError && err.code === ErrorCode.SKILL_NOT_EXECUTABLE && /task-progress/.test(err.message);
  });
  fs.rmSync(root, { recursive: true, force: true });
});
