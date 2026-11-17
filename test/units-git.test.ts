import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StageError } from "../src/core/errors.js";
import { withEnv } from "./helpers/test-utils.js";

/* The async git wrapper (src/git.ts) enforces its output ceiling from INSIDE
 * the stream's 'data' handler. Throwing there escapes EventEmitter.emit() onto
 * the event loop as an uncaughtException and kills the whole process (verified
 * experimentally); the wrapper must REJECT instead. The ceiling is read from
 * AI_FLOW_GIT_MAX_BUFFER at module load, so it is set BEFORE the dynamic
 * import. Each node:test file runs in its own process, so this is hermetic. */

process.env.AI_FLOW_GIT_MAX_BUFFER = "2048";
const { git, gitSync, patchText } = await import("../src/git/git.js");

function tempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-git-"));
  const run = (args: string[]): void => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  // A commit whose message alone streams far past the 2048-byte ceiling.
  fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(20000) + "\n");
  run(["add", "."]);
  run(["commit", "-qm", "x".repeat(20000)]);
  return dir;
}

test("git(): a normal call resolves with the exit result", async () => {
  const dir = tempGitRepo();
  try {
    const result = await git(dir, ["rev-parse", "HEAD"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout.trim(), /^[0-9a-f]{40}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git(): output over the ceiling rejects with a StageError instead of crashing", async () => {
  const dir = tempGitRepo();
  try {
    // git log streams the 20000-byte message: far past the 2048-byte cap.
    await assert.rejects(
      () => git(dir, ["log", "--format=%B", "HEAD"]),
      (err: unknown) =>
        err instanceof StageError &&
        err.kind === "finished" &&
        /exceeded the 2048-byte output limit/.test(err.message),
    );
    // throw-inside-the-data-handler form killed it with an uncaughtException.
    const stillAlive = await git(dir, ["rev-parse", "HEAD"]);
    assert.equal(stillAlive.code, 0, "the wrapper keeps working after an over-ceiling rejection");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git(): a timeout kill surfaces as exit code 124, not a hang", async () => {
  const dir = tempGitRepo();
  try {
    // A git alias that outlives the 300ms timeout (git runs aliases via sh).
    spawnSync("git", ["config", "alias.slow", "!sleep 5"], { cwd: dir, encoding: "utf8" });
    const started = Date.now();
    const result = await git(dir, ["slow"], { timeout: 300 });
    assert.equal(result.code, 124, "a killed-by-timeout child reports the deterministic 124");
    assert.ok(Date.now() - started < 4000, "the timeout must fire, not wait out the child");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* The SYNC wrapper runs inside the pipeline process, where a hung git cannot be
 * interrupted by anything (the run watchdog only signals the agent). It must
 * carry a default ceiling and report a timeout as what it is. */
test("gitSync(): a hung git is killed at the ceiling with a timeout error, not 'failed to start'", () => {
  const dir = tempGitRepo();
  try {
    spawnSync("git", ["config", "alias.slow", "!sleep 5"], { cwd: dir, encoding: "utf8" });
    assert.throws(
      () => gitSync(dir, ["slow"], { timeout: 300 }),
      (err: unknown) =>
        err instanceof StageError &&
        err.kind === "finished" &&
        /git slow timed out after 300ms/.test(err.message),
      "a timeout is a finished-stage failure naming the ceiling, not a spawn failure",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gitSync(): the default ceiling is AI_FLOW_GIT_TIMEOUT_MS, read per call", () => {
  const dir = tempGitRepo();
  try {
    spawnSync("git", ["config", "alias.slow", "!sleep 5"], { cwd: dir, encoding: "utf8" });
    // No explicit option: the environment override decides the ceiling.
    withEnv({ AI_FLOW_GIT_TIMEOUT_MS: "350" }, () => {
      assert.throws(
        () => gitSync(dir, ["slow"]),
        (err: unknown) => err instanceof StageError && /timed out after 350ms/.test(err.message),
      );
    });
    // 0 disables the ceiling entirely (the escape hatch for a legitimately slow op).
    withEnv({ AI_FLOW_GIT_TIMEOUT_MS: "0" }, () => {
      assert.doesNotThrow(() => gitSync(dir, ["rev-parse", "HEAD"]));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* The trusted snapshot (gate-2 patch, phase-3/4 compares) is produced by a git
 * diff over a tree the driven agent has just written to. An in-tree
 * .gitattributes must not be able to SUBSTITUTE the reviewed content: a
 * textconv driver replaces file content in the diff, an external diff driver
 * renders whatever it likes. patchText disables both (--no-textconv
 * --no-ext-diff). An explicit `-diff` marking still degrades that ONE file to a
 * GIT binary patch — but `--binary` keeps the complete delta there (appliable,
 * deterministic), so it costs readability, never integrity. */
test("patchText(): in-tree textconv/external-diff cannot substitute the reviewed content", () => {
  const dir = tempGitRepo();
  const run = (args: string[]): void => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  try {
    fs.writeFileSync(path.join(dir, ".gitattributes"), "note.txt diff=blind\n");
    fs.writeFileSync(path.join(dir, "note.txt"), "one\n");
    run(["config", "diff.blind.textconv", "echo BLIND"]);
    run(["add", "."]);
    run(["commit", "-qm", "attributes"]);
    const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
    fs.appendFileSync(path.join(dir, "note.txt"), "two\n");

    const patch = patchText(dir, base);
    assert.match(patch, /diff --git a\/note\.txt b\/note\.txt/);
    assert.match(patch, /\+two/, "the real added line survives, not the textconv output");
    assert.doesNotMatch(patch, /BLIND/, "the textconv driver must not replace the content");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* An explicit `-diff` attribute marks a file binary (git's own operator intent,
 * which --no-ext-diff deliberately does not override — genuinely binary assets
 * must stay binary). With --binary the section still carries the complete
 * delta, so the change can be neither omitted nor swapped. */
test("patchText(): a -diff-marked file keeps its complete delta instead of vanishing", () => {
  const dir = tempGitRepo();
  const run = (args: string[]): void => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  try {
    fs.writeFileSync(path.join(dir, ".gitattributes"), "note.txt -diff\n");
    fs.writeFileSync(path.join(dir, "note.txt"), "one\n");
    run(["add", "."]);
    run(["commit", "-qm", "attributes"]);
    const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
    fs.appendFileSync(path.join(dir, "note.txt"), "two\n");

    const patch = patchText(dir, base);
    assert.match(patch, /diff --git a\/note\.txt b\/note\.txt/, "the file is still in the reviewed surface");
    assert.match(patch, /GIT binary patch/, "the section keeps the complete (appliable) delta");
    assert.doesNotMatch(patch, /Binary files .* differ/, "never reduced to an unappliable stub");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* The trusted snapshot must agree with the delivery path's RECURSIVE
 * generated-report filter (git.ts isGeneratedReport). A root-only pathspec
 * exclude let a git-added report under a NESTED test-reports dir (a module
 * test dir — playbook P5 records agents doing exactly this) enter the patch,
 * where the phase-3 compare read it as code drift. */
test("patchText(): a nested test-reports file never enters the reviewed surface", () => {
  const dir = tempGitRepo();
  const run = (args: string[]): void => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  try {
    fs.mkdirSync(path.join(dir, "ext", "test-reports"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ext", "test-reports", "out.xml"), "<r1/>\n");
    fs.writeFileSync(path.join(dir, "keep.txt"), "k1\n");
    run(["add", "."]);
    run(["commit", "-qm", "reports"]);
    const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
    // The acceptance runner rewrites the report and the agent git-adds it.
    fs.writeFileSync(path.join(dir, "ext", "test-reports", "out.xml"), "<r2/>\n");
    fs.writeFileSync(path.join(dir, "keep.txt"), "k2\n");

    const patch = patchText(dir, base);
    assert.match(patch, /diff --git a\/keep\.txt b\/keep\.txt/, "the real change stays in the patch");
    assert.doesNotMatch(patch, /test-reports/, "a nested generated report is excluded from the reviewed surface");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
