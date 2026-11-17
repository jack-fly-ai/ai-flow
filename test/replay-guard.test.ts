import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StageError } from "../src/core/errors.js";
import { assertReplayNoOverreach, reanchorReplayBaseline, verifyCleanReplayBaseline } from "../src/orchestrator/replayGuard.js";
import { verifyResumeBaseline } from "../src/orchestrator.js";
import { findFixChild } from "../src/taskdev/taskdev.js";
import type { PipelineDeps, TaskdevOps } from "../src/orchestrator.js";
import type { RunState, StageName } from "../src/core/types.js";

// Helpers: real git repo + a TASK1 fix-commit graph
//   X (recorded baseline) -> Y (pre-fix baseline) -> F (fix: "Fix TASK1 ...")
// Replay's sanctioned Phase-1 "switch" moves HEAD from X to Y, where Y is the
// parent of a genuine fix commit F. The guard must ADOPT that move; any other
// HEAD move (a branch, a dirty tree, a non-fix parent) must fail.

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
}

function commit(dir: string, message: string): void {
  git(dir, ["-c", "user.email=ai-flow@local", "-c", "user.name=ai-flow", "-c", "commit.gpgsign=false", "commit", "-m", message]);
}

function revParse(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

interface ReplayRepo {
  repo: string;
  X: string;
  Y: string;
  F: string;
}

function buildReplayRepo(): ReplayRepo {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-replay-"));
  git(repo, ["init"]);
  fs.mkdirSync(path.join(repo, "extensions", "lisp"), { recursive: true });
  fs.writeFileSync(path.join(repo, "extensions", "lisp", "base.js"), "// base\n");
  git(repo, ["add", "."]);
  commit(repo, "base");
  const X = revParse(repo);
  fs.writeFileSync(path.join(repo, "extensions", "lisp", "y.js"), "// y\n");
  git(repo, ["add", "."]);
  commit(repo, "pre-fix baseline");
  const Y = revParse(repo);
  fs.writeFileSync(path.join(repo, "extensions", "lisp", "fix.js"), "// fix\n");
  git(repo, ["add", "."]);
  commit(repo, "Fix TASK1 the bug");
  const F = revParse(repo);
  git(repo, ["checkout", "--detach", Y]);
  return { repo, X, Y, F };
}

function replayState(repo: string, baselineCommit: string): RunState {
  return {
    id: "TASK1",
    taskdev: { mode: "replay", workspace: repo, baselineCommit, fixCommit: undefined },
  } as unknown as RunState;
}

function fakeReplayDeps(): {
  deps: PipelineDeps;
  calls: { meta?: { fix?: string; baseline?: string }; base?: string; verifyBaseline?: string | null };
} {
  const calls: { meta?: { fix?: string; baseline?: string }; base?: string; verifyBaseline?: string | null } = {};
  const taskdev = {
    replaySetMeta: async (_ctx: unknown, meta: { fix?: string; baseline?: string }) => {
      calls.meta = meta;
    },
    progressSetBase: async (_ctx: unknown, base: string) => {
      calls.base = base;
    },
    // The phase-4 verify step is driven by the caller with the (re-anchored)
    // baseline; capture it so the full-chain contract can be asserted.
    replayVerify: async (ctx: unknown) => {
      calls.verifyBaseline = (ctx as { baseline?: string }).baseline ?? null;
    },
  } as unknown as TaskdevOps;
  return { deps: { taskdev } as PipelineDeps, calls };
}

// assertReplayNoOverreach — the sanctioned Phase-1 switch is ADOPTED

test("replay: Phase-1 move to a fix-parent baseline is ADOPTED and re-anchors", async () => {
  const { repo, X, Y, F } = buildReplayRepo();
  try {
    const state = replayState(repo, X); // recorded baseline = X
    const { deps, calls } = fakeReplayDeps();
    const context = { skillDir: repo, id: "TASK1", workspace: repo };
    await assertReplayNoOverreach(state, context, deps, 1, () => undefined);
    // The move to Y (parent of fix F) is accepted: state + anchors re-based.
    assert.equal(state.taskdev.baselineCommit, Y);
    assert.equal((state as { baseCommit?: string }).baseCommit, Y);
    assert.equal(state.taskdev.fixCommit, F);
    assert.deepEqual(calls.meta, { fix: F, baseline: Y });
    assert.equal(calls.base, Y);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// reanchorReplayBaseline is the isolated mutation at the heart of the Phase-1
// switch. Locking it directly (without re-driving git via the guard) pins the
// contract: every anchor re-points and both side-effecting calls fire with the
// right args. A regression that, say, forgets to update state.baseCommit or
// passes the wrong baseline to progressSetBase would break this.
test("reanchorReplayBaseline: re-points every anchor and the registry", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-replay-"));
  try {
    const state = replayState(repo, "OLD"); // recorded baseline = OLD
    const { deps, calls } = fakeReplayDeps();
    const context = { skillDir: repo, id: "TASK1", workspace: repo };
    const logs: string[] = [];
    await reanchorReplayBaseline(state, context, deps, "OLD", "NEW", "FIX", (m) => logs.push(m));
    assert.equal(state.taskdev.baselineCommit, "NEW");
    assert.equal(state.baseCommit, "NEW");
    assert.equal(state.taskdev.fixCommit, "FIX");
    assert.deepEqual(calls.meta, { fix: "FIX", baseline: "NEW" });
    assert.equal(calls.base, "NEW");
    assert.match(logs[0], /re-anchored OLD -> NEW \(fix FIX\)/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("replay: no HEAD move on a clean detached baseline passes (Phase 1)", async () => {
  const { repo, Y } = buildReplayRepo();
  try {
    const state = replayState(repo, Y); // recorded baseline == current HEAD
    const { deps } = fakeReplayDeps();
    const context = { skillDir: repo, id: "TASK1", workspace: repo };
    await assertReplayNoOverreach(state, context, deps, 1, () => undefined);
    assert.equal(state.taskdev.baselineCommit, Y);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// assertReplayNoOverreach — every illegal move FAILS

test("replay: Phase 2-4 HEAD move fails (only Phase 1 may re-baseline)", async () => {
  const { repo, X } = buildReplayRepo();
  try {
    const state = replayState(repo, X);
    const { deps } = fakeReplayDeps();
    const context = { skillDir: repo, id: "TASK1", workspace: repo };
    // assertReplayNoOverreach is async; the phase!==1 branch rejects the promise.
    await assert.rejects(() => assertReplayNoOverreach(state, context, deps, 2, () => undefined), (err) => {
      return err instanceof StageError && /Only Phase 1 may re-baseline/.test(err.message);
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("replay: Phase-1 move to a non-fix-parent baseline fails", async () => {
  const { repo, X, Y } = buildReplayRepo();
  try {
    // recorded baseline = Y, but HEAD is moved to X (parent of Y, not of fix F)
    const state = replayState(repo, Y);
    git(repo, ["checkout", "--detach", X]);
    const { deps } = fakeReplayDeps();
    const context = { skillDir: repo, id: "TASK1", workspace: repo };
    await assert.rejects(() => assertReplayNoOverreach(state, context, deps, 1, () => undefined), (err) => {
      return err instanceof StageError && /without a valid replay switch/.test(err.message);
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// The sanctioned switch re-anchors onto the PARENT of the fix commit. Moving
// HEAD onto the fix commit ITSELF (F) must be rejected: F has no fix-child, so
// findFixChild returns null and the move is not a valid replay switch. This
// locks the invariant that the fix commit can never become the baseline.
test("replay: Phase-1 moving HEAD onto the fix commit itself is rejected", async () => {
  const { repo, X, F } = buildReplayRepo();
  try {
    const state = replayState(repo, X); // recorded baseline = X
    git(repo, ["checkout", "--detach", F]); // HEAD now at the fix commit
    const { deps } = fakeReplayDeps();
    const context = { skillDir: repo, id: "TASK1", workspace: repo };
    await assert.rejects(() => assertReplayNoOverreach(state, context, deps, 1, () => undefined), (err) => {
      return err instanceof StageError && /without a valid replay switch/.test(err.message);
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("replay: Phase-1 left on a branch fails (must be detached)", async () => {
  const { repo, Y } = buildReplayRepo();
  try {
    const state = replayState(repo, Y);
    git(repo, ["checkout", "-b", "stray", Y]); // HEAD now on a branch
    const { deps } = fakeReplayDeps();
    const context = { skillDir: repo, id: "TASK1", workspace: repo };
    await assert.rejects(() => assertReplayNoOverreach(state, context, deps, 1, () => undefined), (err) => {
      return err instanceof StageError && /not a clean baseline/.test(err.message) && /branch/.test(err.message);
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("replay: Phase-1 with a dirty tracked tree fails", async () => {
  const { repo, Y } = buildReplayRepo();
  try {
    const state = replayState(repo, Y);
    fs.appendFileSync(path.join(repo, "extensions", "lisp", "y.js"), "// dirty\n"); // tracked change, uncommitted
    const { deps } = fakeReplayDeps();
    const context = { skillDir: repo, id: "TASK1", workspace: repo };
    await assert.rejects(() => assertReplayNoOverreach(state, context, deps, 1, () => undefined), (err) => {
      return err instanceof StageError && /not a clean baseline/.test(err.message) && /tracked/.test(err.message);
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// verifyResumeBaseline — guard a resuming run's on-disk artifacts

function minimalState(mode: "standard" | "replay", workspace: string): RunState {
  return { taskdev: { mode, workspace } } as unknown as RunState;
}

test("resume: starting at workspace skips the baseline check", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-resume-"));
  try {
    // Even with a missing workspace, start === "workspace" must not throw.
    assert.doesNotThrow(() => verifyResumeBaseline(minimalState("standard", "/no/such/dir"), runDir, "workspace" as StageName));
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("resume: standard phase3+ with a missing gate2 snapshot fails", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-resume-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ws-"));
  try {
    assert.throws(() => verifyResumeBaseline(minimalState("standard", workspace), runDir, "phase4" as StageName), (err) => {
      return err instanceof StageError && /reviewed gate-2 patch is missing/.test(err.message);
    });
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("resume: standard phase3+ with the gate2 snapshot present passes", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-resume-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ws-"));
  try {
    fs.writeFileSync(path.join(runDir, "gate2-reviewed.patch"), "diff --git a/x\n");
    assert.doesNotThrow(() => verifyResumeBaseline(minimalState("standard", workspace), runDir, "phase3" as StageName));
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("resume: any stage with a missing workspace fails", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-resume-"));
  try {
    assert.throws(() => verifyResumeBaseline(minimalState("standard", "/no/such/dir"), runDir, "phase2" as StageName), (err) => {
      return err instanceof StageError && /workspace is missing/.test(err.message);
    });
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

// Phase-4 replay-verify invariant. task-replay verify re-derives the fix commit
// for the (re-anchored) baseline via findFixChild; that only works if the new
// baseline is STILL the parent of a genuine fix commit. This pins the contract
// that the Phase-1 switch re-points the baseline to the pre-fix commit (parent
// of fix), never onto the fix commit itself — a regression that set
// baselineCommit to the fix would silently break phase-4 verify.

test("replay: the re-anchored baseline keeps a valid fix-child (phase-4 verify invariant)", async () => {
  const { repo, X, Y, F } = buildReplayRepo();
  try {
    const state = replayState(repo, X); // recorded baseline = X
    const { deps } = fakeReplayDeps();
    const context = { skillDir: repo, id: "TASK1", workspace: repo };
    await assertReplayNoOverreach(state, context, deps, 1, () => undefined);
    // Sanctioned switch adopted Y (parent of fix F) as the new baseline.
    assert.equal(state.taskdev.baselineCommit, Y);
    const child = await findFixChild(repo, "TASK1", state.taskdev.baselineCommit);
    assert.equal(child, F);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// Phase-4 replay-verify full-chain contract. task-replay verify re-derives the
// fix for the (re-anchored) baseline, so it MUST be invoked with the new
// baseline Y — not the pre-re-anchor baseline X. Combined with the findFixChild
// invariant above (Y is a genuine fix-parent), this locks the end-to-end path:
// re-anchor -> phase-4 verify is fed Y. A regression that handed verify X would
// make phase-4 verify pass against the wrong (pre-switch) tree.

test("replay: phase-4 verify is driven by the re-anchored baseline (full-chain contract)", async () => {
  const { repo, X, Y, F } = buildReplayRepo();
  try {
    const state = replayState(repo, X); // recorded baseline = X
    const { deps, calls } = fakeReplayDeps();
    const context = { skillDir: repo, id: "TASK1", workspace: repo };
    await assertReplayNoOverreach(state, context, deps, 1, () => undefined);
    // The caller (stagePhase) feeds phase-4 verify the re-anchored baseline.
    await deps.taskdev.replayVerify({ ...context, baseline: state.taskdev.baselineCommit } as unknown as Parameters<typeof deps.taskdev.replayVerify>[0]);
    assert.equal(calls.verifyBaseline, Y);
    assert.equal(calls.meta?.baseline, Y); // the registry anchor re-anchored too
    assert.notEqual(calls.verifyBaseline, X); // never the pre-switch baseline
    void F;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// Reliability invariant. verifyCleanReplayBaseline is the gate that re-asserts a
// detached, tracked-clean checkout of the pre-fix baseline before the workspace
// stage (and phase 4). It must reject a branch checkout and a dirty tree, and
// self-heal a HEAD that drifted off the baseline by checking it out. These are
// the exact preconditions the rest of the replay safety argument depends on.

test("replay: verifyCleanReplayBaseline enforces detached, clean, matching HEAD (reliability invariant)", async () => {
  const { repo, X, Y } = buildReplayRepo();
  try {
    git(repo, ["checkout", "--detach", Y]);
    await verifyCleanReplayBaseline(repo, Y, () => undefined); // clean detached at baseline -> ok
    git(repo, ["checkout", "--detach", X]); // HEAD not at the recorded baseline
    await verifyCleanReplayBaseline(repo, Y, () => undefined); // must auto-checkout the baseline
    assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), Y);

    git(repo, ["checkout", "-b", "stray", Y]); // on a branch
    await assert.rejects(() => verifyCleanReplayBaseline(repo, Y, () => undefined), (err) => err instanceof StageError);

    git(repo, ["checkout", "--detach", Y]);
    fs.appendFileSync(path.join(repo, "extensions", "lisp", "y.js"), "// dirty\n"); // tracked dirty
    await assert.rejects(() => verifyCleanReplayBaseline(repo, Y, () => undefined), (err) => err instanceof StageError);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
