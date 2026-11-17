import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { finishStage, readState, skipRest, StateConflictError, withStateUpdate } from "../src/state/store.js";
import { StageError } from "../src/core/errors.js";
import type { AgentRequest } from "../src/agents/runner.js";
import { runPipeline } from "../src/orchestrator.js";
import type { TaskdevContext } from "../src/taskdev/taskdev.js";
import { SKILL_DIR, config, fakeTaskdev, happyAgent, depsWith, initReplayHistory, agentWithoutGate2Patch, initRepo, git, cleanup } from "./helpers/pipeline-helpers.js";
import { waitUntil } from "./helpers/test-utils.js";

test("standard run drives the task-dev state machine and stops at gate 4", async () => {
  const root = initRepo();
  process.env.TASK_PACKAGE_DIR = path.join(root, "packages");
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    const result = await runPipeline({
      repoRoot: root,
      id: "TASK1",
      log: () => undefined,
      config,
      deps: depsWith(fake, happyAgent(fake, ctx)),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.state.status, "awaiting_review");
    assert.equal(result.state.awaiting?.kind, "gate4");
    assert.equal(result.state.taskdev.mode, "standard");
    assert.equal(result.state.taskdev.pack, "viewers");
    assert.equal(result.state.taskdev.gates?.[1], "passed");
    assert.equal(result.state.taskdev.gates?.[2], "passed");
    assert.equal(result.state.taskdev.gates?.[3], "passed");
    assert.equal(result.state.taskdev.gates?.[4], "pending");
    assert.equal(result.state.taskdev.phase, 4);
    assert.equal(result.state.stages.review.status, "awaiting_review");

    // task-dev evidence and delivery
    assert.equal(fs.existsSync(path.join(root, ".task-dev", "TASK1", "phase1-requirement.md")), true);
    assert.equal(fs.existsSync(path.join(root, ".task-dev", "TASK1", "phase2-review.md")), true);
    assert.equal(fs.existsSync(path.join(root, ".task-dev", "TASK1", "phase3-test-report.md")), true);
    assert.match(fs.readFileSync(path.join(root, ".task-dev", "TASK1", "deliverables", "TC-TASK1.md"), "utf8"), /Test case/);
    assert.equal(fs.existsSync(path.join(root, ".ai-flow", "runs", "TASK1", "changes.patch")), true);
    assert.match(result.state.artifacts.package ?? "", /TASK1_\d{12}\.tar\.gz/);
    assert.equal(fs.existsSync(result.state.artifacts.package ?? ""), true);
    assert.equal(result.state.test?.verdict, "passed");

    // prompts carry hard rules and workflow paths
    const prompt2 = fs.readFileSync(path.join(root, ".ai-flow", "runs", "TASK1", "prompts", "phase2.md"), "utf8");
    assert.match(prompt2, /Never git commit/);
    assert.match(prompt2, /phase2-implementation\.md/);
    assert.match(prompt2, /references\/viewers/);

    // gate 4 has not been passed yet — the human passes it on approve
    assert.equal(fake.snapshot(ctx).gates[4], "pending");

    // the run is waiting for review, so it cannot be restarted
    await assert.rejects(
      () => runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, happyAgent(fake, ctx)) }),
      (err: unknown) => err instanceof StageError && err.kind === "startup",
    );
  } finally {
    cleanup(root);
  }
});

test("a viewer stop racing the pipeline is preserved, not clobbered by a stage failure", async () => {
  // while the pipeline is still running. When the stop lands in the
  // pipeline's error window — e.g. the stop kills the run, the pipeline's
  // overwrote the operator's record: the run showed a stage error instead
  // of "Stopped by user". The pipeline now re-reads the disk and defers to
  const root = initRepo();
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const racingAgent = async (request: AgentRequest): Promise<{ exitCode: number; commandName: string }> => {
      const prompt = fs.readFileSync(request.promptFile, "utf8");
      if (prompt.includes("Phase 1 (requirement)")) {
        // The viewer's Stop mid-phase-1: the exact mutator stopRun uses.
        const runDir = path.join(root, ".ai-flow", "runs", "TASK1");
        await withStateUpdate(runDir, (s) => {
          if (s.status !== "running") throw new StateConflictError(`${s.id} is no longer running (${s.status})`);
          const stage = s.stage;
          finishStage(s, stage, "failed", { exitCode: null, error: "Stopped by user; state preserved — Retry to resume from here." });
          s.status = "failed";
          s.error = `Stopped by user at ${stage}; task-dev state preserved — Retry to resume, Delete to remove.`;
          skipRest(s, stage);
        });
      }
      return { exitCode: 0, commandName: "fake-agent" };
    };
    const result = await runPipeline({
      repoRoot: root,
      id: "TASK1",
      log: () => undefined,
      config,
      deps: depsWith(fake, racingAgent),
    });
    const stored = readState(path.join(root, ".ai-flow", "runs", "TASK1"));
    assert.equal(result.exitCode, 2);
    // The stopper's record survives byte-for-byte: no stage-failure text.
    assert.equal(stored.status, "failed");
    assert.equal(stored.error, "Stopped by user at phase1; task-dev state preserved — Retry to resume, Delete to remove.");
    assert.equal(stored.stages.phase1.error, "Stopped by user; state preserved — Retry to resume from here.");
    assert.equal(result.state.error, stored.error, "the pipeline reports the deferred record, not its own failure");
    // The lock is released and the run can be retried from the failed stage.
    assert.equal(fs.existsSync(path.join(root, ".ai-flow", "runs", "TASK1", "run.lock")), false, "the run lock is released");
  } finally {
    cleanup(root);
  }
});

test("a second runPipeline on the same ticket is refused while the lock is held", async () => {
  const root = initRepo();
  // A process whose cmdline reads like an ai-flow pipeline: `node -e <script>`
  // keeps every argv token visible in /proc/<pid>/cmdline, unlike
  // `bash -c 'sleep 30' ai-flow cli.js run` — bash exec-optimizes the simple
  // command and replaces its own image with `sleep`, dropping the marker
  // tokens that isAiFlowPipeline looks for.
  const pipeline = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "ai-flow", "cli.js", "run"], { stdio: "ignore" });
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    // The lock refusal depends on the fixture being a LIVE, recognizable
    // ai-flow process (marker tokens in /proc/<pid>/cmdline); wait for
    // exactly that precondition instead of a blind settle sleep.
    await waitUntil(
      () => {
        try {
          const argv = fs.readFileSync(`/proc/${pipeline.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
          return argv.includes("ai-flow") && argv.includes("cli.js") && argv.includes("run");
        } catch {
          return false;
        }
      },
      { message: "the pipeline fixture never became a recognizable ai-flow process" },
    );
    const runDir = path.join(root, ".ai-flow", "runs", "TASK1");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "run.lock"), JSON.stringify({ pid: pipeline.pid, startedAt: new Date().toISOString() }));
    await assert.rejects(
      () => runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, happyAgent(fake, ctx)) }),
      (err: unknown) => err instanceof StageError && /already in progress/.test(err.message),
    );
    // After the holder is gone the stale lock is reaped and the ticket runs.
    // The reap reads /proc/<pid>/cmdline: an empty one (zombie or gone) is
    // what classifies the lock as stale — wait for that, not a fixed delay.
    pipeline.kill("SIGKILL");
    await waitUntil(
      () => {
        try {
          return fs.readFileSync(`/proc/${pipeline.pid}/cmdline`, "utf8").length === 0;
        } catch {
          return true; // gone entirely
        }
      },
      { message: "the killed pipeline fixture never exited" },
    );
    const result = await runPipeline({
      repoRoot: root,
      id: "TASK1",
      log: () => undefined,
      config,
      deps: depsWith(fake, happyAgent(fake, ctx)),
    });
    assert.equal(result.state.taskdev.mode, "standard");
  } finally {
    if (pipeline.pid !== undefined) {
      try {
        process.kill(pipeline.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    cleanup(root);
  }
});

test("an E1 escalation pauses the run and the answer resumes the same phase", async () => {
  const root = initRepo();
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    const agent = happyAgent(fake, ctx);
    fs.writeFileSync(path.join(root, ".ask-e1"), "1\n");

    const first = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, agent) });
    assert.equal(first.exitCode, 0);
    assert.equal(first.state.status, "awaiting_review");
    assert.deepEqual(first.state.awaiting, { kind: "clarification", code: "E1" });
    assert.equal(first.state.stage, "phase1");
    assert.equal(fake.snapshot(ctx).gates[1], "pending");

    // Human answers: resume phase1 with the answer injected.
    const runDir = path.join(root, ".ai-flow", "runs", "TASK1");
    const stored = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
    stored.rework = { stage: "phase1", comment: "The answer is: use the shared pool", at: "2026-09-28T00:00:00.000Z" };
    fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(stored));
    fs.rmSync(path.join(root, ".ask-e1"));

    let phase1Prompts = 0;
    const countingAgent = async (request: AgentRequest) => {
      const prompt = fs.readFileSync(request.promptFile, "utf8");
      if (prompt.includes("Phase 1 (requirement)")) phase1Prompts += 1;
      return agent(request);
    };
    const second = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, countingAgent) });
    assert.equal(second.exitCode, 0);
    assert.equal(second.state.status, "awaiting_review");
    assert.equal(second.state.awaiting?.kind, "gate4");
    assert.equal(phase1Prompts, 1);
    const answered = fs.readFileSync(path.join(runDir, "prompts", "phase1.md"), "utf8");
    assert.match(answered, /use the shared pool/);
    assert.equal(fake.snapshot(ctx).awaiting, null);
  } finally {
    cleanup(root);
  }
});

test("a gate-4 rejection rewinds to phase2, resets gates, and reruns", async () => {
  const root = initRepo();
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    const first = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, happyAgent(fake, ctx)) });
    assert.equal(first.state.status, "awaiting_review");

    const runDir = path.join(root, ".ai-flow", "runs", "TASK1");
    const stored = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
    stored.rework = { stage: "phase2", comment: "Wrong approach, redo the implementation", at: "2026-09-28T00:00:00.000Z" };
    fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(stored));

    const prompts: string[] = [];
    const countingAgent = async (request: AgentRequest) => {
      prompts.push(path.basename(request.promptFile));
      return happyAgent(fake, ctx)(request);
    };
    const second = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, countingAgent) });
    assert.equal(second.exitCode, 0);
    assert.equal(second.state.status, "awaiting_review");
    assert.equal(second.state.rework, undefined);
    assert.deepEqual(prompts, ["phase2.md", "phase3.md", "phase4.md"]);
    assert.match(fs.readFileSync(path.join(runDir, "prompts", "phase2.md"), "utf8"), /Wrong approach/);
    // task-progress reset the downstream gates on the backward move
    assert.equal(fake.snapshot(ctx).gates[2], "passed");
    assert.equal(fake.snapshot(ctx).gates[3], "passed");
  } finally {
    cleanup(root);
  }
});

test("a failed phase3 resumes at phase3 without re-running earlier phases", async () => {
  const root = initRepo();
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    let phase3Runs = 0;
    const flakyAgent = async (request: AgentRequest) => {
      const prompt = fs.readFileSync(request.promptFile, "utf8");
      if (prompt.includes("Phase 3 (testing)")) {
        phase3Runs += 1;
        if (phase3Runs === 1) throw new StageError("test host unavailable", "finished", 3, "accept");
      }
      return happyAgent(fake, ctx)(request);
    };
    const first = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, flakyAgent) });
    assert.equal(first.exitCode, 2);
    assert.equal(first.state.stages.phase3.status, "failed");
    assert.equal(first.state.stages.phase4.status, "skipped");

    const second = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, flakyAgent) });
    assert.equal(second.exitCode, 0);
    assert.equal(second.state.status, "awaiting_review");
    assert.equal(phase3Runs, 2);
    assert.equal(second.state.stages.phase1.status, "passed");
    assert.equal(second.state.stages.phase4.status, "passed");
  } finally {
    cleanup(root);
  }
});

test("a failed phase2 (first attempt) resumes without a full reset", async () => {
  // for ANY resume at phase 2 or later — but phase 2 is the stage that WRITES
  // that file, so a first-attempt phase-2 failure demanded a full reset.
  const root = initRepo();
  process.env.TASK_PACKAGE_DIR = path.join(root, "packages");
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    let phase2Runs = 0;
    const flakyAgent = async (request: AgentRequest) => {
      const prompt = fs.readFileSync(request.promptFile, "utf8");
      if (prompt.includes("Phase 2 (implementation")) {
        phase2Runs += 1;
        if (phase2Runs === 1) throw new StageError("fake phase-2 agent crash", "finished", 1, "fake-agent");
      }
      return happyAgent(fake, ctx)(request);
    };
    const first = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, flakyAgent) });
    assert.equal(first.exitCode, 2);
    assert.equal(first.state.status, "failed");
    assert.equal(first.state.stage, "phase2");
    // The first attempt never reached the gate-2 snapshot write.
    assert.equal(fs.existsSync(path.join(root, ".ai-flow", "runs", "TASK1", "gate2-reviewed.patch")), false);

    // Retry: must resume at phase 2 (not demand a reset) and finish cleanly.
    const second = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, flakyAgent) });
    assert.equal(second.exitCode, 0, `retry should complete: ${second.state.error ?? ""}`);
    assert.equal(second.state.status, "awaiting_review");
    assert.equal(phase2Runs, 2);
    assert.equal(second.state.stages.phase1.status, "passed");
    assert.equal(second.state.stages.phase4.status, "passed");
  } finally {
    cleanup(root);
  }
});

test("changes outside the module scope fail phase2 before any gate passes", async () => {
  const root = initRepo();
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    const rogueAgent = async (request: AgentRequest) => {
      const prompt = fs.readFileSync(request.promptFile, "utf8");
      if (prompt.includes("Phase 2 (implementation")) {
        fs.writeFileSync(path.join(request.cwd, "README.md"), "nope\n");
      }
      return happyAgent(fake, ctx)(request);
    };
    const result = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, rogueAgent) });
    assert.equal(result.exitCode, 2);
    assert.equal(result.state.stages.phase2.status, "failed");
    assert.equal(result.state.taskdev.gates?.[2], "pending");
    assert.equal(result.state.artifacts.package, undefined);
  } finally {
    cleanup(root);
  }
});

test("phase3 code drift outside the test area fails before gate 3", async () => {
  const root = initRepo();
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    const driftAgent = async (request: AgentRequest) => {
      const prompt = fs.readFileSync(request.promptFile, "utf8");
      if (prompt.includes("Phase 3 (testing)")) {
        fs.writeFileSync(path.join(request.cwd, "extensions/lisp/init.js"), ";;; drifted after review\n");
      }
      return happyAgent(fake, ctx)(request);
    };
    const result = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, driftAgent) });
    assert.equal(result.exitCode, 2);
    assert.equal(result.state.stages.phase3.status, "failed");
    assert.equal(result.state.taskdev.gates?.[3], "pending");
    assert.match(result.state.error ?? "", /change surface no longer matches the gate-2 review/);
    assert.equal(result.state.artifacts.package, undefined);
  } finally {
    cleanup(root);
  }
});

test("drift surviving a phase-3 escalation is caught at phase 4", async () => {
  const root = initRepo();
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    let firstPhase3 = true;
    const agent = async (request: AgentRequest) => {
      const prompt = fs.readFileSync(request.promptFile, "utf8");
      if (prompt.includes("Phase 3 (testing)") && firstPhase3) {
        firstPhase3 = false;
        // Drift the reviewed tree, then block on an escalation. The resume
        // re-snapshots on entry, so the phase-3 check alone cannot see this.
        fs.writeFileSync(path.join(request.cwd, "extensions/lisp/init.js"), ";;; drifted after review\n");
        fake.snapshot(ctx).awaiting = "E2";
      }
      return happyAgent(fake, ctx)(request);
    };
    const first = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, agent) });
    assert.equal(first.exitCode, 0);
    assert.equal(first.state.status, "awaiting_review");
    assert.deepEqual(first.state.awaiting, { kind: "escalation", code: "E2" });

    // Human resolves the escalation; phase 3 finishes on the drifted tree.
    const runDir = path.join(root, ".ai-flow", "runs", "TASK1");
    const stored = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
    stored.rework = { stage: "phase3", comment: "Escalation resolved", at: "2026-09-28T00:00:00.000Z" };
    fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(stored));

    const second = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, agent) });
    assert.equal(second.exitCode, 2);
    assert.equal(second.state.stages.phase3.status, "passed");
    assert.equal(second.state.taskdev.gates?.[3], "passed");
    assert.equal(second.state.stages.phase4.status, "failed");
    assert.match(second.state.error ?? "", /gate-2 review/);
    assert.equal(second.state.artifacts.package, undefined);
  } finally {
    cleanup(root);
  }
});

test("replay mode routes diff and packaging through task-replay", async () => {
  const root = initRepo();
  try {
    // A real replay tree is a detached checkout of the baseline (task-replay
    // init always lands detached); the clean-baseline invariant requires it.
    git(root, ["checkout", "--quiet", "--detach"]);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const fake = fakeTaskdev({
      ensure: { mode: "replay", workspace: root },
      fixCommit: "fixcommit",
      replay: {
        replayDir: root,
        taskDevDir: path.join(root, ".task-dev"),
        baselineCommit: head,
        fixCommit: "fixcommit",
      },
    });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root, taskDevDir: path.join(root, ".task-dev") };
    const result = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, happyAgent(fake, ctx)) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.state.taskdev.mode, "replay");
    assert.equal(result.state.taskdev.fixCommit, "fixcommit");
    assert.equal(result.state.taskdev.baselineCommit, head);
    assert.equal(result.state.baseCommit, head);
    assert.equal(result.state.artifacts.package, "/tmp/replay-package.tar.gz");
    const prompt1 = fs.readFileSync(path.join(root, ".ai-flow", "runs", "TASK1", "prompts", "phase1.md"), "utf8");
    assert.match(prompt1, /REPLAY MODE/);
    assert.match(prompt1, /fixcommit/);
  } finally {
    cleanup(root);
  }
});

/**
 * Fixture history: R (init) → A0 → B (the genuine TASK1 fix,
 * subject-mention + content) → M (merge-style) → H (a harness commit that
 * mentions TASK1 only in its body). The STALE anchor is H (baseline M, which
 * already contains the fix); the CORRECT anchor is B (baseline A0).
 */
test("replay: the sanctioned Phase-1 re-baseline is adopted, not failed as overreach (incident-shaped)", async () => {
  const h = initReplayHistory();
  const metaStore: { fix?: string; baseline?: string } = { fix: h.harness, baseline: h.merge };
  try {
    // The run starts anchored on the STALE harness commit (old findFixCommit /
    // registry reuse): detached, tracked-clean at the harness commit's parent.
    git(h.root, ["checkout", "--quiet", "--detach", h.merge]);
    const fake = fakeTaskdev({
      ensure: { mode: "replay", workspace: h.root },
      fixCommit: h.harness,
      replay: { replayDir: h.root, taskDevDir: path.join(h.root, ".task-dev"), baselineCommit: h.merge, fixCommit: h.harness },
      metaStore,
    });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: h.root, taskDevDir: path.join(h.root, ".task-dev") };
    const baseAgent = happyAgent(fake, ctx);
    const agent = async (request: AgentRequest) => {
      const prompt = fs.readFileSync(request.promptFile, "utf8");
      if (prompt.includes("Phase 1 (requirement)")) {
        // Disambiguation: the supplied anchor is a harness commit. Perform the
        // replay switch (real run: task-replay init + task-progress set meta base).
        git(h.root, ["checkout", "--quiet", "--detach", h.a0]);
        fake.snapshot(ctx).base = h.a0;
      }
      return baseAgent(request);
    };
    const result = await runPipeline({ repoRoot: h.root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, agent) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.state.status, "awaiting_review");
    // The re-anchored baseline is adopted and every anchor agrees.
    assert.equal(result.state.baseCommit, h.a0);
    assert.equal(result.state.taskdev.baselineCommit, h.a0);
    assert.equal(result.state.taskdev.fixCommit, h.fix);
    assert.equal(metaStore.baseline, h.a0, "the replay registry is re-anchored too (task-replay diff/verify/package must run against the real baseline)");
    assert.equal(metaStore.fix, h.fix);
    assert.equal(fake.snapshot(ctx).base, h.a0, "progress.md is re-anchored so task-verify-tree and later sessions agree");
  } finally {
    cleanup(h.root);
  }
});

test("replay: a stale tool anchor is re-anchored to the true fix at the workspace stage", async () => {
  const h = initReplayHistory();
  const metaStore: { fix?: string; baseline?: string } = { fix: h.harness, baseline: h.merge };
  try {
    git(h.root, ["checkout", "--quiet", "--detach", h.merge]);
    let replayCalls = 0;
    const fake = fakeTaskdev({
      ensure: { mode: "replay", workspace: h.root },
      fixCommit: h.fix, // the corrected detection: the genuine fix
      replay: (fixCommit: string) => {
        replayCalls++;
        if (replayCalls === 1) {
          // The registry reuse wins the first call: the stale anchor comes back.
          return { replayDir: h.root, taskDevDir: path.join(h.root, ".task-dev"), baselineCommit: h.merge, fixCommit: h.harness };
        }
        // The cross-check re-runs task-replay init: checkout <true-fix>^ and rewrite the registry.
        git(h.root, ["checkout", "--quiet", "--detach", h.a0]);
        metaStore.fix = fixCommit;
        metaStore.baseline = h.a0;
        return { replayDir: h.root, taskDevDir: path.join(h.root, ".task-dev"), baselineCommit: h.a0, fixCommit };
      },
      metaStore,
    });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: h.root, taskDevDir: path.join(h.root, ".task-dev") };
    const result = await runPipeline({ repoRoot: h.root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, happyAgent(fake, ctx)) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.state.status, "awaiting_review");
    assert.equal(replayCalls, 2, "the mismatched anchor triggers exactly one re-init");
    assert.equal(result.state.baseCommit, h.a0);
    assert.equal(result.state.taskdev.baselineCommit, h.a0);
    assert.equal(result.state.taskdev.fixCommit, h.fix);
    assert.equal(metaStore.baseline, h.a0);
    assert.equal(metaStore.fix, h.fix);
  } finally {
    cleanup(h.root);
  }
});

test("replay: a phase-1 commit still fails as overreach (a new commit is never a valid switch)", async () => {
  const h = initReplayHistory();
  try {
    git(h.root, ["checkout", "--quiet", "--detach", h.merge]);
    const fake = fakeTaskdev({
      ensure: { mode: "replay", workspace: h.root },
      fixCommit: h.harness,
      replay: { replayDir: h.root, taskDevDir: path.join(h.root, ".task-dev"), baselineCommit: h.merge, fixCommit: h.harness },
    });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: h.root, taskDevDir: path.join(h.root, ".task-dev") };
    const baseAgent = happyAgent(fake, ctx);
    const agent = async (request: AgentRequest) => {
      const prompt = fs.readFileSync(request.promptFile, "utf8");
      if (prompt.includes("Phase 1 (requirement)")) {
        // The agent commits (forbidden). Even with a matching progress base,
        // the new commit is not the parent of a genuine TASK1 fix → overreach.
        fs.writeFileSync(path.join(h.root, "src/cheat.ts"), ";;; cheat\n");
        git(h.root, ["add", "."]);
        git(h.root, ["-c", "user.email=a@b", "-c", "user.name=a", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "agent commit"]);
        fake.snapshot(ctx).base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: h.root, encoding: "utf8" }).trim();
      }
      return baseAgent(request);
    };
    const result = await runPipeline({ repoRoot: h.root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, agent) });
    assert.equal(result.exitCode, 2);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.stages.phase1.status, "failed");
    assert.match(result.state.error ?? "", /without a valid replay switch/);
  } finally {
    cleanup(h.root);
  }
});

test("replay: phase 1 must end on a tracked-clean baseline (no code before gate 2)", async () => {
  const h = initReplayHistory();
  try {
    git(h.root, ["checkout", "--quiet", "--detach", h.merge]);
    const fake = fakeTaskdev({
      ensure: { mode: "replay", workspace: h.root },
      fixCommit: h.harness,
      replay: { replayDir: h.root, taskDevDir: path.join(h.root, ".task-dev"), baselineCommit: h.merge, fixCommit: h.harness },
    });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: h.root, taskDevDir: path.join(h.root, ".task-dev") };
    const baseAgent = happyAgent(fake, ctx);
    const agent = async (request: AgentRequest) => {
      const prompt = fs.readFileSync(request.promptFile, "utf8");
      if (prompt.includes("Phase 1 (requirement)")) {
        // The agent gets ahead: a tracked change during the requirement phase.
        fs.appendFileSync(path.join(h.root, "src/m.ts"), ";;; early change\n");
      }
      return baseAgent(request);
    };
    const result = await runPipeline({ repoRoot: h.root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, agent) });
    assert.equal(result.exitCode, 2);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.stages.phase1.status, "failed");
    assert.match(result.state.error ?? "", /not a clean baseline after phase 1/);
  } finally {
    cleanup(h.root);
  }
});

test("replay: the workspace stage restores leftover tracked changes to a clean baseline", async () => {
  const h = initReplayHistory();
  try {
    git(h.root, ["checkout", "--quiet", "--detach", h.merge]);
    // A crashed prior run of the same TASK left a tracked modification behind.
    fs.appendFileSync(path.join(h.root, "src/m.ts"), ";;; leftover\n");
    const fake = fakeTaskdev({
      ensure: { mode: "replay", workspace: h.root },
      fixCommit: h.harness,
      replay: { replayDir: h.root, taskDevDir: path.join(h.root, ".task-dev"), baselineCommit: h.merge, fixCommit: h.harness },
    });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: h.root, taskDevDir: path.join(h.root, ".task-dev") };
    const result = await runPipeline({ repoRoot: h.root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, happyAgent(fake, ctx)) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.state.status, "awaiting_review");
    assert.equal(fs.readFileSync(path.join(h.root, "src/m.ts"), "utf8"), ";;; m\n", "the leftover is restored byte-for-byte to the baseline");
  } finally {
    cleanup(h.root);
  }
});

test("replay: a session killed before the gate-2 patch was saved still completes (orchestrator snapshots it)", async () => {
  const root = initRepo();
  try {
    git(root, ["checkout", "--quiet", "--detach"]);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const fake = fakeTaskdev({
      ensure: { mode: "replay", workspace: root },
      fixCommit: "fixcommit",
      replay: { replayDir: root, taskDevDir: path.join(root, ".task-dev"), baselineCommit: head, fixCommit: "fixcommit" },
    });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root, taskDevDir: path.join(root, ".task-dev") };
    const logs: string[] = [];
    const result = await runPipeline({ repoRoot: root, id: "TASK1", log: (m: string) => logs.push(m), config, deps: depsWith(fake, agentWithoutGate2Patch(fake, ctx)) });
    assert.equal(result.exitCode, 0, result.state.error ?? undefined);
    assert.equal(result.state.status, "awaiting_review");
    const patch = path.join(root, ".task-dev", "TASK1", "checkpoints", "TASK1_gate2.patch");
    assert.ok(fs.existsSync(patch), "the orchestrator writes the gate-2 patch itself");
    assert.equal(fs.readFileSync(patch, "utf8"), "diff --git a/extensions/lisp/added.js\n", "replay mode: the bytes are task-replay diff");
    assert.ok(logs.some((l) => l.includes("WARNING: the agent left no gate-2 patch")));
  } finally {
    cleanup(root);
  }
});

test("standard: a missing gate-2 patch is snapshotted by the orchestrator", async () => {
  const root = initRepo();
  const prevPkgDir = process.env.TASK_PACKAGE_DIR;
  process.env.TASK_PACKAGE_DIR = root;
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    const logs: string[] = [];
    const result = await runPipeline({ repoRoot: root, id: "TASK1", log: (m: string) => logs.push(m), config, deps: depsWith(fake, agentWithoutGate2Patch(fake, ctx)) });
    assert.equal(result.exitCode, 0, result.state.error ?? undefined);
    assert.equal(result.state.status, "awaiting_review");
    assert.ok(fs.existsSync(path.join(root, ".task-dev", "TASK1", "checkpoints", "TASK1_gate2.patch")), "the orchestrator writes the gate-2 patch itself");
    assert.ok(logs.some((l) => l.includes("WARNING: the agent left no gate-2 patch")));
  } finally {
    if (prevPkgDir === undefined) delete process.env.TASK_PACKAGE_DIR;
    else process.env.TASK_PACKAGE_DIR = prevPkgDir;
    cleanup(root);
  }
});
