import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { StageError } from "../../src/core/errors.js";
import { EXPECTED_SKILL_TOOLS } from "../../src/taskdev/taskdev-contract.js";
import type { AgentRequest } from "../../src/agents/runner.js";
import type { PipelineDeps, TaskdevOps } from "../../src/orchestrator.js";
import type { GateNumber } from "../../src/core/types.js";
import type { ProgressSnapshot, ReplayInit, TaskdevContext, WorkspaceEnsure } from "../../src/taskdev/taskdev.js";
import type { AiFlowConfig } from "../../src/core/types.js";

/* Synthetic roots have no issues.json; the gate is covered by issues.test.ts. */
process.env.AI_FLOW_ISSUE_GATE ??= "off";
// The pipeline suite is split by domain: pipeline-core (standard-mode
// flows, resume/rewind, scope/drift guards, replay mode),
// pipeline-misc (reset/stop/ops, corrupted-state resilience, delivery)
// and pipeline-ui (viewer HTTP surface, createRun lifecycle).
const SKILL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-skill-"));
const SKILL_DIR = path.join(SKILL_ROOT, "skills", "task-dev");
fs.mkdirSync(path.join(SKILL_DIR, "tools"), { recursive: true });
// The runtime's skill contract: the three executables under tools/ that the
// orchestrator shells out to (verifySkillContract fails fast when absent).
for (const tool of EXPECTED_SKILL_TOOLS) {
  const toolPath = path.join(SKILL_DIR, "tools", tool);
  fs.writeFileSync(toolPath, "#!/bin/sh\n");
  fs.chmodSync(toolPath, 0o755);
}
process.on("exit", () => fs.rmSync(SKILL_ROOT, { recursive: true, force: true }));
const REAL_SKILL_DIR = process.env.AI_FLOW_TEST_SKILL_DIR ?? path.resolve(import.meta.dirname, "../../skills/task-dev");

const config: AiFlowConfig = {
  runner: { command: ["fake-agent", "{promptFile}"] },
  taskdev: { skillDir: SKILL_DIR },
};

// packageDir() falls back to ~/task, which is read-only on some test hosts:
// pin the file to a writable temp dir unless the variable is already set.
// (Individual tests may still point it at their own root; tests that change
// it must restore the previous value so this pin survives the suite.)
if (!process.env.TASK_PACKAGE_DIR) {
  process.env.TASK_PACKAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-pkg-"));
}
// Fake task-dev control plane (in-memory task-progress)

interface FakeProgress {
  phase: number | "aborted";
  gates: Partial<Record<GateNumber, "pending" | "passed" | "rejected">>;
  awaiting: string | null;
  notes: string[];
  base?: string;
}

function fakeTaskdev(options: {
  ensure?: WorkspaceEnsure;
  replay?: ReplayInit | ((fixCommit: string) => ReplayInit);
  fixCommit?: string | null;
  /** Mutable stand-in for the replay registry (replay-TASKxxxx.meta). */
  metaStore?: { fix?: string; baseline?: string };
} = {}) {
  const progress = new Map<string, FakeProgress>();
  const api = {
    ops: {
      workspaceEnsure: async (req: { skillDir: string; id: string }) =>
        options.ensure ?? { mode: "standard" as const, workspace: process.env.__WORKSPACE__ ?? "" },
      findFixCommit: async () => options.fixCommit ?? null,
      replayInit: async (opts: { skillDir: string; id: string; fixCommit: string; repo: string }): Promise<ReplayInit> => {
        if (!options.replay) throw new StageError("unexpected replay init", "finished", 1);
        return typeof options.replay === "function" ? options.replay(opts.fixCommit) : options.replay;
      },
      progressInit: async (ctx: TaskdevContext): Promise<void> => {
        api.get(ctx);
      },
      progressShow: async (ctx: TaskdevContext): Promise<ProgressSnapshot> => {
        const state = api.get(ctx);
        return {
          phase: state.phase,
          rounds: 0,
          mode: "file",
          track: "auto",
          base: state.base,
          gates: state.gates,
          awaiting: state.awaiting,
          notes: state.notes,
        };
      },
      progressSetPhase: async (ctx: TaskdevContext, phase: number | "aborted"): Promise<void> => {
        api.get(ctx).phase = phase;
      },
      progressSetGate: async (ctx: TaskdevContext, gate: GateNumber, status: "pending" | "passed" | "rejected"): Promise<void> => {
        api.get(ctx).gates[gate] = status;
      },
      progressSetBase: async (ctx: TaskdevContext, base: string): Promise<void> => {
        api.get(ctx).base = base;
      },
      progressAwaiting: async (ctx: TaskdevContext, escalation: string | "clear"): Promise<void> => {
        api.get(ctx).awaiting = escalation === "clear" ? null : escalation;
      },
      progressNote: async (ctx: TaskdevContext, text: string): Promise<void> => {
        api.get(ctx).notes.push(text);
      },
      replayVerify: async () => "ok",
      replayAudit: async () => "clean",
      replayDiff: async () => "diff --git a/extensions/lisp/added.js\n",
      replayDiffNames: async () => ["extensions/lisp/added.js"],
      replayPackage: async (_ctx: TaskdevContext, _paths: string[]) => "/tmp/replay-package.tar.gz",
      replayMeta: () => options.metaStore ?? null,
      replaySetMeta: async (_ctx: TaskdevContext, meta: { fix?: string; baseline?: string }): Promise<void> => {
        const store = options.metaStore;
        if (!store) return;
        if (meta.fix) store.fix = meta.fix;
        if (meta.baseline) store.baseline = meta.baseline;
      },
    } satisfies TaskdevOps,
    get(ctx: TaskdevContext): FakeProgress {
      const key = `${ctx.taskDevDir ?? path.join(ctx.workspace, ".task-dev")}/${ctx.id}`;
      let state = progress.get(key);
      if (!state) {
        state = { phase: 0, gates: { 1: "pending", 2: "pending", 3: "pending", 4: "pending" }, awaiting: null, notes: [] };
        progress.set(key, state);
      }
      return state;
    },
    snapshot(ctx: TaskdevContext): FakeProgress {
      return api.get(ctx);
    },
  };
  return api;
}
// Fake agents

function stateDirOf(cwd: string): string {
  const root = path.join(cwd, ".task-dev");
  const existing = fs.existsSync(root) ? fs.readdirSync(root).find((name) => /^TASK\d+$/.test(name)) : undefined;
  return path.join(root, existing ?? "TASK1");
}

function writeStateFiles(cwd: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(stateDirOf(cwd), name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
}

/** Agent that follows the whole task-dev flow: artifacts per phase, code in phase2. */
function happyAgent(fake: ReturnType<typeof fakeTaskdev>, ctx: TaskdevContext) {
  return async (request: AgentRequest) => {
    const prompt = fs.readFileSync(request.promptFile, "utf8");
    if (prompt.includes("Phase 1 (requirement)")) {
      writeStateFiles(request.cwd, {
        "phase1-requirement.md": "# Requirement\n\nrepro: n/a\n\nmodule pack: viewers\n",
        "attachment/ticket-body.md": "# TASK1 body\n",
        "attachment/ticket-comments.md": "# comments\n",
        "deliverables/clarification-comments.md": "No blocking questions.\n",
      });
      if (fake.snapshot(ctx).awaiting === null && fs.existsSync(path.join(request.cwd, ".ask-e1"))) {
        fake.snapshot(ctx).awaiting = "E1";
      }
    } else if (prompt.includes("Phase 2 (implementation")) {
      fs.mkdirSync(path.join(request.cwd, "extensions/lisp"), { recursive: true });
      fs.writeFileSync(path.join(request.cwd, "extensions/lisp/added.js"), ";;; FILE: added.js\n");
      writeStateFiles(request.cwd, {
        "phase2-plan.md": "# Plan\n- step\n",
        "phase2-review.md": "## Self-review\nok\n\n## Independent review\nok\n",
        "phase4-handoff.md": "# Handoff\n- extensions/lisp/added.js\n",
        "checkpoints/TASK1_gate2.patch": "diff --git a/extensions/lisp/added.js\n",
      });
    } else if (prompt.includes("Phase 3 (testing)")) {
      writeStateFiles(request.cwd, {
        "phase3-test-plan.md": "# Test plan\n- case 1\n",
        "phase3-test-report.md": "# Report\n\nPASS=1 FAIL=0 SKIP=0\n",
      });
    } else if (prompt.includes("Phase 4 (deliverables)")) {
      writeStateFiles(request.cwd, {
        "deliverables/TC-TASK1.md": "# Test case\n",
        "deliverables/CHANGES-TASK1.patch": "diff --git a/extensions/lisp/added.js\n",
      });
    }
    return { exitCode: 0, commandName: "fake-agent" };
  };
}

function depsWith(fake: ReturnType<typeof fakeTaskdev>, agent: (request: AgentRequest) => Promise<{ exitCode: number; commandName: string }>): Partial<PipelineDeps> {
  return {
    runAgent: agent,
    taskdev: fake.ops,
  };
}
/**
 * Fixture history: R (init) → A0 → B (the genuine TASK1 fix,
 * subject-mention + content) → M (merge-style) → H (a harness commit that
 * mentions TASK1 only in its body). The STALE anchor is H (baseline M, which
 * already contains the fix); the CORRECT anchor is B (baseline A0).
 */
function initReplayHistory(): { root: string; a0: string; fix: string; merge: string; harness: string } {
  const root = initRepo();
  const commitMsg = (message: string): void =>
    git(root, ["-c", "user.email=ai-flow@local", "-c", "user.name=ai-flow", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  const head = (): string => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.ts"), ";;; a\n");
  git(root, ["add", "."]);
  commitMsg("unrelated baseline work");
  const a0 = head();
  fs.writeFileSync(path.join(root, "src/b.ts"), ";;; b\n");
  git(root, ["add", "."]);
  commitMsg("TASK1 - the report view crashes when the record id is not found");
  const fix = head();
  fs.writeFileSync(path.join(root, "src/m.ts"), ";;; m\n");
  git(root, ["add", "."]);
  commitMsg("Merge branch 'feature-branch' into main");
  const merge = head();
  fs.mkdirSync(path.join(root, "ai-flow"), { recursive: true });
  fs.writeFileSync(path.join(root, "ai-flow/tweak.ts"), "// tweak\n");
  git(root, ["add", "."]);
  commitMsg("ai-flow: fix test verdict parse, viewer/task-replay tweaks\n\n(fixes false 'Failed' on TASK1)");
  const harness = head();
  return { root, a0, fix, merge, harness };
}
function agentWithoutGate2Patch(fake: ReturnType<typeof fakeTaskdev>, ctx: TaskdevContext) {
  const base = happyAgent(fake, ctx);
  return async (request: AgentRequest) => {
    const result = await base(request);
    if (fs.readFileSync(request.promptFile, "utf8").includes("Phase 2 (implementation")) {
      fs.rmSync(path.join(stateDirOf(request.cwd), "checkpoints", "TASK1_gate2.patch"), { force: true });
    }
    return result;
  };
}
function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-repo-"));
  git(dir, ["init"]);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# test\n");
  fs.mkdirSync(path.join(dir, "extensions/lisp"), { recursive: true });
  fs.writeFileSync(path.join(dir, "extensions/lisp/init.js"), ";;; FILE: init.js\n");
  git(dir, ["add", "."]);
  commit(dir);
  return dir;
}

function commit(cwd: string): void {
  git(cwd, ["-c", "user.email=ai-flow@local", "-c", "user.name=ai-flow", "-c", "commit.gpgsign=false", "commit", "-m", "init"]);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

export {
  SKILL_DIR,
  REAL_SKILL_DIR,
  config,
  fakeTaskdev,
  happyAgent,
  depsWith,
  stateDirOf,
  writeStateFiles,
  initReplayHistory,
  agentWithoutGate2Patch,
  initRepo,
  commit,
  git,
  cleanup,
};
