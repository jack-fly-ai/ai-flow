import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stopPipeline } from "../src/state/stop.js";
import { readState, readStateOrNull, writeState } from "../src/state/store.js";
import { StageError } from "../src/core/errors.js";
import type { AgentRequest } from "../src/agents/runner.js";
import { runPipeline } from "../src/orchestrator.js";
import { filterPatchToProductSurface, patchText } from "../src/git/git.js";
import { progressAwaiting, progressInit, progressNote, progressSetGate, progressSetPhase, progressShow, runToolOrThrow } from "../src/taskdev/taskdev.js";
import { registryDir, resetRun } from "../src/state/reset.js";
import type { TaskdevContext } from "../src/taskdev/taskdev.js";
import type { AiFlowConfig } from "../src/core/types.js";
import { startUi } from "../src/viewer/server.js";
import { waitUntil, withEnv } from "./helpers/test-utils.js";
import { SKILL_DIR, REAL_SKILL_DIR, config, fakeTaskdev, happyAgent, depsWith, writeStateFiles, initRepo, commit, git, cleanup } from "./helpers/pipeline-helpers.js";

test("reset removes the run record, workspace, replay tree, wrapper and registry", async () => {
  const root = initRepo();
  const registry = path.join(root, "registry");
  fs.mkdirSync(registry, { recursive: true });
  // task-replay init seeds <project>_aireplay/project and task-workspace registers
  // the workspace clone — both are created trees a full delete removes.
  const workspace = path.join(root, "demo_task1_ai", "project");
  const replayDir = path.join(root, "demo_task1_aireplay", "project");
  const replayWrapper = path.join(root, "demo_task1_aireplay");
  fs.mkdirSync(path.join(workspace, ".task-dev", "TASK1"), { recursive: true });
  fs.mkdirSync(replayDir, { recursive: true });
  fs.mkdirSync(path.join(root, ".ai-flow", "runs", "TASK1"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ai-flow", "runs", "TASK1", "state.json"), "{}");
  fs.writeFileSync(path.join(workspace, ".task-dev", "TASK1", "progress.md"), "phase: 4\n");
  fs.writeFileSync(path.join(registry, "TASK1"), `${workspace}\n`);
  fs.writeFileSync(path.join(registry, "TASK1.mode"), "replay\n");
  fs.writeFileSync(path.join(registry, "replay-TASK1.path"), `${replayDir}\n`);
  fs.writeFileSync(path.join(registry, "replay-TASK1.meta"), "fix=abc\n");
  try {
    await withEnv({ TASK_WORKSPACE_REGISTRY: registry }, () => resetRun({ repoRoot: root, id: "TASK1", log: () => undefined }));
    assert.equal(fs.existsSync(path.join(root, ".ai-flow", "runs", "TASK1")), false);
    assert.equal(fs.existsSync(replayDir), false);
    assert.equal(fs.existsSync(replayWrapper), false);
    assert.equal(fs.existsSync(path.join(registry, "replay-TASK1.path")), false);
    assert.equal(fs.existsSync(path.join(registry, "replay-TASK1.meta")), false);
    // A full delete takes the created workspace and every registry entry with
    // it, so the next run starts from scratch.
    assert.equal(fs.existsSync(workspace), false);
    assert.equal(fs.existsSync(path.join(registry, "TASK1")), false);
    assert.equal(fs.existsSync(path.join(registry, "TASK1.mode")), false);
  } finally {
    cleanup(root);
  }
  assert.equal(registryDir().endsWith("registry"), false);
});

test("a stale pre-migration run record starts fresh instead of erroring", async () => {
  const root = initRepo();
  try {
    const runDir = path.join(root, ".ai-flow", "runs", "TASK1");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "state.json"),
      JSON.stringify({
        id: "TASK1",
        status: "failed",
        stage: "analyze",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        baseCommit: "abc",
        worktree: root,
        stages: { analyze: { status: "failed" } },
        artifacts: {},
        error: "old pipeline failure",
      }),
    );
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    const result = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, happyAgent(fake, ctx)) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.state.status, "awaiting_review");
    assert.equal(result.state.taskdev.mode, "standard");
    assert.equal(result.state.stages.workspace.status, "passed");
  } finally {
    cleanup(root);
  }
});

// Corrupted state.json resilience (one bad record must not crash anything)

test("viewer answers a corrupted state.json with JSON errors, not a crash", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-corrupt-"));
  const registry = path.join(root, "registry");
  const runDir = path.join(root, ".ai-flow", "runs", "2");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), "{ this is not valid json");
  await withEnv({ TASK_WORKSPACE_REGISTRY: registry }, async () => {
    const server = await startUi(root, "127.0.0.1", 0, {
      startRun: () => {
        throw new Error("a corrupted run must never be (re)started");
      },
    });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    try {
      // Every state-reading endpoint degrades to a JSON error...
      const detail = await fetch(`http://127.0.0.1:${port}/api/runs/2`);
      assert.equal(detail.status, 500);
      assert.match(((await detail.json()) as { error: string }).error, /corrupted/);

      const created = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "2" }),
      });
      assert.equal(created.status, 409);

      const reviewed = await fetch(`http://127.0.0.1:${port}/api/runs/2/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });
      assert.equal(reviewed.status, 500);

      const stopped = await fetch(`http://127.0.0.1:${port}/api/runs/2/stop`, { method: "POST" });
      assert.equal(stopped.status, 500);

      const packaged = await fetch(`http://127.0.0.1:${port}/api/runs/2/package`);
      assert.equal(packaged.status, 500);

      // ...and the server is still alive for other runs.
      const list = await fetch(`http://127.0.0.1:${port}/api/runs`);
      assert.equal(list.status, 200);

      // Delete is the way out of a corrupted record (resetRun only needs the id).
      const removed = await fetch(`http://127.0.0.1:${port}/api/runs/2`, { method: "DELETE" });
      assert.equal(removed.status, 200);
      const removedBody = (await removed.json()) as { deleted: boolean };
      assert.equal(removedBody.deleted, true);
      assert.equal(fs.existsSync(path.join(runDir, "state.json")), false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test("runPipeline rejects a corrupted state file with a clear startup error", async () => {
  const root = initRepo();
  try {
    const runDir = path.join(root, ".ai-flow", "runs", "TASK1");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "state.json"), "{ broken");
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    await assert.rejects(
      () => runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, happyAgent(fake, ctx)) }),
      (err: unknown) =>
        err instanceof StageError && err.kind === "startup" && /corrupted/i.test(err.message) && /reset/.test(err.message),
    );
  } finally {
    cleanup(root);
  }
});

test("writeState is atomic: no temp file left, corrupted file reads as null", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-atomic-"));
  try {
    const state = {
      id: "TASK1",
      status: "running" as const,
      stage: "workspace" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      baseCommit: "abc",
      worktree: root,
      stages: {} as never,
      artifacts: {},
      taskdev: { mode: "standard" as const, workspace: root, gates: {} },
      error: null,
    };
    writeState(root, state);
    // No leftover temp file after a successful write. The temp name is
    // unique per process+moment (state.json.tmp-<pid>-<epoch>) so the check
    // must glob the prefix, not one fixed name.
    assert.ok(!fs.readdirSync(root).some((name) => name.startsWith("state.json.tmp")), "no temp file left");
    assert.equal(readState(root).id, "TASK1");
    assert.equal(readStateOrNull(root)?.id, "TASK1");
    // A corrupted file is reported as null, not as an exception.
    fs.writeFileSync(path.join(root, "state.json"), "{ torn");
    assert.equal(readStateOrNull(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Stop: the agent is killed by recorded pid, never by an unanchored pattern

test("stopPipeline kills the live agent from agent.pid and ignores stale pids", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-stop-"));
  const runDir = path.join(dir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  try {
    const config: AiFlowConfig = { runner: { command: [process.execPath] } };
    // Live agent: the pid file points at a real, matching process.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    const pid = child.pid;
    assert.ok(pid);
    // Reap the child so that once it dies its pid actually disappears — an
    // unreaped zombie would still answer process.kill(pid, 0).
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    fs.writeFileSync(path.join(runDir, "agent.pid"), String(pid));
    // stopAgent verifies the recorded pid against /proc/<pid>/cmdline; wait
    // until the spawned agent is visible there instead of a blind sleep.
    await waitUntil(
      () => {
        try {
          return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).length > 0;
        } catch {
          return false;
        }
      },
      { message: "the spawned agent never appeared in /proc" },
    );
    const outcome = await stopPipeline(runDir, config, "TASK1");
    assert.equal(outcome.agent.killed, true);
    assert.equal(outcome.agent.pid, pid);
    await exited;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "the recorded agent must be dead");

    // Stale pid file (process gone): reported, not an error, nothing killed.
    fs.writeFileSync(path.join(runDir, "agent.pid"), "999999999");
    const stale = await stopPipeline(runDir, config, "TASK1");
    assert.equal(stale.agent.stale, true);
    assert.equal(stale.agent.killed, false);

    // No pid file: missing, nothing to kill.
    fs.rmSync(path.join(runDir, "agent.pid"), { force: true });
    const missing = await stopPipeline(runDir, config, "TASK1");
    assert.equal(missing.agent.missing, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("full-log includes the repo-level start-<id>.log", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-fulllog-"));
  const runDir = path.join(root, ".ai-flow", "runs", "4");
  fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "logs", "phase1.log"), "phase one output\n");
  fs.mkdirSync(path.join(root, ".ai-flow", "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ai-flow", "logs", "start-4.log"), "startup failure: fake-agent not found\n");
  const server = await startUi(root, "127.0.0.1", 0, { startRun: () => undefined });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runs/4/full-log`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /===== phase1 =====/);
    assert.match(text, /phase one output/);
    assert.match(text, /===== start-4 =====/);
    assert.match(text, /fake-agent not found/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("runPipeline reports a startup failure (exit code 1) when the config is missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-noconfig-"));
  try {
    // No ai-flow.config.json anywhere under this root: loadConfig throws a
    // startup StageError, which the CLI maps to exit code 1 (never a stage-2).
    await assert.rejects(
      () => runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined }),
      (err: unknown) => err instanceof StageError && err.kind === "startup",
    );
  } finally {
    cleanup(root);
  }
});

test("escalations E1-E7 pause the run with the right awaiting kind and resume on the answer", async () => {
  for (const code of ["E1", "E2", "E3", "E4", "E5", "E6", "E7"]) {
    const root = initRepo();
    try {
      const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
      const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
      // The escalation is raised exactly once (on the first phase-1 pass);
      // the resumed pass must run clean and complete through to gate 4.
      let escalated = false;
      const agent = async (request: AgentRequest) => {
        const prompt = fs.readFileSync(request.promptFile, "utf8");
        if (prompt.includes("Phase 1 (requirement)")) {
          writeStateFiles(request.cwd, {
            "phase1-requirement.md": "# Requirement\n\nrepro: n/a\n\nmodule pack: viewers\n",
            "attachment/ticket-body.md": "# TASK1 body\n",
            "attachment/ticket-comments.md": "# comments\n",
            "deliverables/clarification-comments.md": "No blocking questions.\n",
          });
          if (!escalated) {
            escalated = true;
            fake.snapshot(ctx).awaiting = code;
          }
        } else {
          await happyAgent(fake, ctx)(request);
        }
        return { exitCode: 0, commandName: "fake-agent" };
      };
      const first = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, agent) });
      assert.equal(first.exitCode, 0);
      assert.equal(first.state.status, "awaiting_review");
      assert.equal(first.state.stage, "phase1");
      const expectedKind = code === "E1" ? "clarification" : "escalation";
      assert.deepEqual(first.state.awaiting, { kind: expectedKind, code });

      // The human answers: the run resumes the same phase with the answer injected.
      const runDir = path.join(root, ".ai-flow", "runs", "TASK1");
      const stored = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8")) as { rework?: unknown };
      stored.rework = { stage: "phase1", comment: `answer for ${code}`, at: "2026-09-28T00:00:00.000Z" };
      fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(stored));
      const second = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, agent) });
      assert.equal(second.exitCode, 0);
      assert.equal(second.state.status, "awaiting_review");
      assert.equal(second.state.awaiting?.kind, "gate4");
      assert.match(fs.readFileSync(path.join(runDir, "prompts", "phase1.md"), "utf8"), new RegExp(`answer for ${code}`));
    } finally {
      cleanup(root);
    }
  }
});

test("the delivery tarball contains the changed code and no runtime state", async () => {
  const root = initRepo();
  const pkgDir = path.join(root, "packages");
  const prevPkgDir = process.env.TASK_PACKAGE_DIR;
  process.env.TASK_PACKAGE_DIR = pkgDir;
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    const result = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, happyAgent(fake, ctx)) });
    assert.equal(result.exitCode, 0);
    const tarPath = result.state.artifacts.package ?? "";
    assert.ok(tarPath && fs.existsSync(tarPath), "the package tarball exists");
    const listing = execFileSync("tar", ["tzf", tarPath], { encoding: "utf8" });
    const entries = listing.split("\n").filter(Boolean).map((line) => line.replace(/^\.\//, ""));
    assert.ok(entries.includes("extensions/lisp/added.js"), "the changed product file is packed");
    for (const entry of entries) {
      assert.ok(entry !== ".task-dev" && !entry.startsWith(".task-dev/"), "task-dev state must never be packaged");
      assert.ok(entry !== ".ai-flow" && !entry.startsWith(".ai-flow/"), "pipeline runtime must never be packaged");
      assert.ok(entry !== "skills" && !entry.startsWith("skills/"), "seeded skills must never be packaged");
    }
  } finally {
    if (prevPkgDir === undefined) delete process.env.TASK_PACKAGE_DIR;
    else process.env.TASK_PACKAGE_DIR = prevPkgDir;
    cleanup(root);
  }
});

test("a stage failure carrying a secret is redacted before it lands in state.json", async () => {
  const root = initRepo();
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const agent = async (_request: AgentRequest): Promise<{ exitCode: number; commandName: string }> => {
      throw new StageError("fetch failed: Bugzilla_logincookie=SECRET_COOKIE_VALUE_12345", "finished", 1, "fake-agent");
    };
    // A stage failure does not reject: runPipeline records it and returns
    // exit code 2 (exit 1 is reserved for never-started processes).
    const result = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, agent) });
    assert.equal(result.exitCode, 2);
    assert.equal(result.state.status, "failed");
    const stored = fs.readFileSync(path.join(root, ".ai-flow", "runs", "TASK1", "state.json"), "utf8");
    assert.ok(!stored.includes("SECRET_COOKIE_VALUE_12345"), "the cookie value must not reach the run record");
    assert.match(stored, /<redacted>/);
  } finally {
    cleanup(root);
  }
});

test("stopPipeline kills the ticket-anchored CLI process and spares other tickets", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-stop-"));
  const runDir = path.join(dir, ".ai-flow", "runs", "TASK77777");
  fs.mkdirSync(runDir, { recursive: true });
  const marker = (ticket: string) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "cli.js", "run", ticket], { stdio: "ignore" });
  const target = marker("TASK77777");
  const other = marker("TASK88888");
  // Prefix-related ticket: "cli.js run TASK77777" is a substring of
  // "cli.js run TASK777779", so without the pattern's trailing boundary the
  // anchored pkill would kill this pipeline too.
  const prefix = marker("TASK777779");
  const alive = (pid: number | undefined): boolean => {
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForExit = (pid: number | undefined, ms: number): Promise<void> =>
    new Promise((resolve) => {
      const started = Date.now();
      const tick = (): void => {
        if (!alive(pid) || Date.now() - started > ms) return resolve();
        setTimeout(tick, 100);
      };
      tick();
    });
  await waitUntil(() => alive(target.pid) && alive(other.pid) && alive(prefix.pid), {
    message: "the marker processes never started",
  });
  try {
    assert.ok(alive(target.pid), "the target CLI process started");
    assert.ok(alive(other.pid), "the other ticket's CLI process started");
    assert.ok(alive(prefix.pid), "the prefix-related ticket's CLI process started");
    const outcome = await stopPipeline(runDir, { runner: { command: [] } } as AiFlowConfig, "TASK77777");
    assert.equal(outcome.agent.missing, true);
    await waitForExit(target.pid, 8000);
    assert.equal(alive(target.pid), false, "the ticket-anchored process was killed");
    assert.equal(alive(other.pid), true, "the other ticket's process is spared");
    assert.equal(alive(prefix.pid), true, "the prefix-related ticket's process is spared (trailing boundary)");
  } finally {
    if (target.pid !== undefined && alive(target.pid)) process.kill(target.pid, "SIGKILL");
    if (other.pid !== undefined && alive(other.pid)) process.kill(other.pid, "SIGKILL");
    if (prefix.pid !== undefined && alive(prefix.pid)) process.kill(prefix.pid, "SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resetRun kills the ticket-anchored CLI process via its fallback pattern when the config is missing", async () => {
  // form `cli\.(?:js|ts)` — invalid POSIX ERE, so pkill's regcomp failed
  // (exit 2) and silently killed NOTHING, letting the orphan pipeline
  // survive the record deletion.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-reset-fallback-"));
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-reset-registry-"));
  const marker = (ticket: string) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "cli.js", "run", ticket], { stdio: "ignore" });
  const target = marker("TASK555");
  const prefix = marker("TASK5551");
  const alive = (pid: number | undefined): boolean => {
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForExit = (pid: number | undefined, ms: number): Promise<void> =>
    new Promise((resolve) => {
      const started = Date.now();
      const tick = (): void => {
        if (!alive(pid) || Date.now() - started > ms) return resolve();
        setTimeout(tick, 100);
      };
      tick();
    });
  await waitUntil(() => alive(target.pid) && alive(prefix.pid), {
    message: "the marker processes never started",
  });
  try {
    assert.ok(alive(target.pid), "the target CLI process started");
    assert.ok(alive(prefix.pid), "the prefix-related ticket's CLI process started");
    // No ai-flow.config.json in the repo root: loadConfig throws, so reset
    // takes its fallback pattern path. The registry override is scoped to
    // this call (withEnv restores it, so it cannot leak into later tests).
    await withEnv({ TASK_WORKSPACE_REGISTRY: registry }, () => resetRun({ repoRoot: root, id: "TASK555", log: () => undefined }));
    await waitForExit(target.pid, 8000);
    assert.equal(alive(target.pid), false, "the fallback pattern killed the ticket-anchored process");
    assert.equal(alive(prefix.pid), true, "the prefix-related ticket's process is spared");
  } finally {
    if (target.pid !== undefined && alive(target.pid)) process.kill(target.pid, "SIGKILL");
    if (prefix.pid !== undefined && alive(prefix.pid)) process.kill(prefix.pid, "SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(registry, { recursive: true, force: true });
  }
});

test("ui /api/mcp lists, upserts, toggles and removes MCP servers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-mcp-ui-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-mcp-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  fs.writeFileSync(path.join(root, "ai-flow.config.json"), JSON.stringify({ agent: "cursor", model: "", runner: { command: ["fake-agent", "{promptFile}"] } }));
  const server = await startUi(root, "127.0.0.1", 0, { startRun: () => undefined });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    const base = `http://127.0.0.1:${port}/api/mcp`;
    const listed = (await (await fetch(base)).json()) as {
      agent: string | null;
      supported: boolean;
      scopes: Array<{ scope: string; path: string; servers: Array<{ name: string }> }>;
    };
    assert.equal(listed.agent, "cursor");
    assert.equal(listed.supported, true);
    const userScope = listed.scopes.find((scope) => scope.scope === "user");
    assert.ok(userScope, "the user scope is listed");
    assert.equal(userScope.path, path.join(home, ".cursor", "mcp.json"));
    const configFile = path.join(home, ".cursor", "mcp.json");

    // Upsert a stdio server.
    const upsert = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "user", name: "github-mcp", spec: { type: "stdio", command: "npx", args: ["-y", "github-mcp"] } }),
    });
    assert.equal(upsert.status, 200);
    const file1 = JSON.parse(fs.readFileSync(configFile, "utf8")) as { mcpServers: Record<string, { command?: string; args?: string[] }> };
    assert.equal(file1.mcpServers["github-mcp"].command, "npx");

    // Toggle it off (native `disabled` flag round-trips).
    const toggle = await fetch(`${base}/github-mcp?scope=user`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(toggle.status, 200);
    const file2 = JSON.parse(fs.readFileSync(configFile, "utf8")) as { mcpServers: Record<string, { disabled?: boolean }> };
    assert.equal(file2.mcpServers["github-mcp"].disabled, true);

    // Remove it.
    const removed = await fetch(`${base}/github-mcp?scope=user`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const file3 = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
    assert.equal((file3.mcpServers as Record<string, unknown>)["github-mcp"], undefined);

    // An invalid server name is rejected with 400.
    const bad = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "user", name: "bad name!", spec: { type: "stdio", command: "echo" } }),
    });
    assert.equal(bad.status, 400);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("filterPatchToProductSurface byte-matches the product-surface snapshot on real git output", () => {
  const root = initRepo();
  try {
    // A tracked test-area file in the base commit, so the tree diff (not just
    // the untracked --no-index additions) carries test-area sections.
    fs.mkdirSync(path.join(root, "extensions/test"), { recursive: true });
    fs.writeFileSync(path.join(root, "extensions/test", "old_test.ts"), ";;; base test\n");
    git(root, ["add", "."]);
    commit(root);
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

    // Tracked product + tracked test change, untracked product + test files.
    fs.writeFileSync(path.join(root, "extensions/lisp", "init.ts"), ";;; FILE: init.ts\n;;; edited\n");
    fs.writeFileSync(path.join(root, "extensions/lisp", "new.ts"), ";;; FILE: new.ts\n");
    fs.writeFileSync(path.join(root, "extensions/test", "old_test.ts"), ";;; base test\n;;; edited\n");
    fs.writeFileSync(path.join(root, "extensions/test", "new_test.ts"), ";;; new test\n");

    const full = patchText(root, base);
    const product = patchText(root, base, {
      diffExclude: [":(exclude)extensions/test"],
      pathExclude: (file) => file.startsWith("extensions/test/"),
    });
    assert.ok(full.includes("extensions/test/old_test.ts") && full.includes("extensions/test/new_test.ts"), "the full patch carries the test area");
    assert.ok(!product.includes("extensions/test/old_test.ts") && !product.includes("extensions/test/new_test.ts"), "the snapshot excludes the test area");
    // The legacy-compat guarantee: narrowing the FULL-tree patch an older
    // ai-flow version would have written must reproduce the product snapshot
    // byte-for-byte (tree sections adjacent, untracked additions joined).
    assert.equal(filterPatchToProductSurface(full, ["extensions/test/"]), product);
    assert.equal(filterPatchToProductSurface(full, []), full);
  } finally {
    cleanup(root);
  }
});

test("a legacy full-tree gate2-reviewed.patch passes the phase-4 compare after a phase-4 rework", async () => {
  const root = initRepo();
  const pkgDir = path.join(root, "packages");
  const prevPkgDir = process.env.TASK_PACKAGE_DIR;
  process.env.TASK_PACKAGE_DIR = pkgDir;
  try {
    const fake = fakeTaskdev({ ensure: { mode: "standard", workspace: root } });
    const ctx: TaskdevContext = { skillDir: SKILL_DIR, id: "TASK1", workspace: root };
    const first = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, happyAgent(fake, ctx)) });
    assert.equal(first.exitCode, 0);
    assert.equal(first.state.awaiting?.kind, "gate4");

    // Simulate an upgrade: the trusted patch was written by an older version
    // (FULL tree, no surface marker in state), and the run is reworked into
    // phase 4.
    const runDir = path.join(root, ".ai-flow", "runs", "TASK1");
    fs.writeFileSync(path.join(runDir, "gate2-reviewed.patch"), patchText(root, first.state.baseCommit), "utf8");
    const stateFile = path.join(runDir, "state.json");
    const stored = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { taskdev: { gate2Surface?: string }; rework?: unknown };
    delete stored.taskdev.gate2Surface;
    stored.rework = { stage: "phase4", comment: "legacy compat check", at: "2026-09-28T00:00:00.000Z" };
    fs.writeFileSync(stateFile, JSON.stringify(stored));

    const second = await runPipeline({ repoRoot: root, id: "TASK1", log: () => undefined, config, deps: depsWith(fake, happyAgent(fake, ctx)) });
    assert.equal(second.exitCode, 0, "an upgraded run with a legacy full-tree patch must not false-fail");
    assert.equal(second.state.awaiting?.kind, "gate4");
  } finally {
    if (prevPkgDir === undefined) delete process.env.TASK_PACKAGE_DIR;
    else process.env.TASK_PACKAGE_DIR = prevPkgDir;
    cleanup(root);
  }
});

test("ui /api/runs/:id/message resumes a failed phase with the answer injected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-msg-ui-"));
  const writeRun = (id: string, status: string, stage: string): void => {
    const runDir = path.join(root, ".ai-flow", "runs", id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "state.json"),
      JSON.stringify({
        id,
        status,
        stage,
        startedAt: "2026-09-28T00:00:00.000Z",
        updatedAt: "2026-09-28T00:00:00.000Z",
        baseCommit: "abc",
        worktree: root,
        stages: { [stage]: { status } },
        artifacts: {},
        taskdev: { mode: "standard", workspace: root, gates: { 1: "pending", 2: "pending", 3: "pending", 4: "pending" }, phase: Number(stage.replace("phase", "")) },
        error: status === "failed" ? "agent exited 1" : null,
      }),
    );
  };
  writeRun("6", "failed", "phase2");
  writeRun("7", "awaiting_review", "review");
  const started: string[] = [];
  const server = await startUi(root, "127.0.0.1", 0, {
    startRun: (_repoRoot, id) => {
      started.push(id);
    },
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    // A failed run with a message: rework recorded, review kind "message", respawn.
    const sent = await fetch(`http://127.0.0.1:${port}/api/runs/6/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comment: "try the other fix" }),
    });
    assert.equal(sent.status, 202);
    const sentBody = (await sent.json()) as { resumedFrom: string };
    assert.equal(sentBody.resumedFrom, "phase2");
    const stored = JSON.parse(fs.readFileSync(path.join(root, ".ai-flow", "runs", "6", "state.json"), "utf8")) as {
      rework?: { stage: string; comment: string };
      reviews?: Array<{ decision: string; stage: string; comment: string }>;
    };
    assert.equal(stored.rework?.stage, "phase2");
    assert.equal(stored.rework?.comment, "try the other fix");
    assert.ok(stored.rework !== undefined && "at" in stored.rework, "the rework record carries a timestamp");
    assert.equal(stored.reviews?.at(-1)?.decision, "message");
    assert.deepEqual(started, ["6"]);

    // An empty message is rejected, an awaiting run gets 409 (review actions only).
    const empty = await fetch(`http://127.0.0.1:${port}/api/runs/6/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comment: "  " }),
    });
    assert.equal(empty.status, 400);
    const notFailed = await fetch(`http://127.0.0.1:${port}/api/runs/7/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comment: "nope" }),
    });
    assert.equal(notFailed.status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runTool reports a timeout as a timeout, not a start failure", async () => {
  // for a tool that ran and ran long.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-timeout-"));
  const skillDir = path.join(dir, "skills", "task-dev");
  const toolsDir = path.join(skillDir, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  const tool = path.join(toolsDir, "task-progress");
  fs.writeFileSync(tool, "#!/usr/bin/env bash\nsleep 5\n", "utf8");
  fs.chmodSync(tool, 0o755);
  try {
    await assert.rejects(
      runToolOrThrow({ skillDir, tool: "task-progress", args: ["show", "TASK1"], cwd: dir, timeoutMs: 300 }),
      (err: unknown) => err instanceof StageError && /timed out after 300ms/.test(err.message),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("real task-progress drives the taskdev wrappers end-to-end (skipped without the skill)", {
  skip: !fs.existsSync(path.join(REAL_SKILL_DIR, "tools", "task-progress")),
}, async () => {
  const root = initRepo();
  const ctx: TaskdevContext = { skillDir: REAL_SKILL_DIR, id: "9", workspace: root };
  try {
    // task-progress init requires the state root (normally created by
    // task-workspace ensure / phase 0); stand it up directly.
    fs.mkdirSync(path.join(root, ".task-dev", "9"), { recursive: true });
    await progressInit(ctx);
    let snapshot = await progressShow(ctx);
    assert.equal(snapshot.phase, 0);
    assert.deepEqual(snapshot.gates, { 1: "pending", 2: "pending", 3: "pending", 4: "pending" });
    assert.equal(snapshot.awaiting, null);

    await progressSetPhase(ctx, 1);
    await progressNote(ctx, "module pack: viewers");
    // The real tool enforces gate evidence: gate 1 needs the requirement
    // (with a repro conclusion) plus the raw ticket sources on disk.
    const taskDir = path.join(root, ".task-dev", "9");
    fs.mkdirSync(path.join(taskDir, "attachment"), { recursive: true });
    fs.writeFileSync(path.join(taskDir, "phase1-requirement.md"), "# Requirement\n\nrepro: n/a\n");
    fs.writeFileSync(path.join(taskDir, "attachment", "ticket-body.md"), "# 9 body\n");
    fs.writeFileSync(path.join(taskDir, "attachment", "ticket-comments.md"), "# comments\n");
    await progressSetGate(ctx, 1, "passed");
    await progressAwaiting(ctx, "E3");
    snapshot = await progressShow(ctx);
    assert.equal(snapshot.phase, 1);
    assert.equal(snapshot.gates[1], "passed");
    assert.equal(snapshot.awaiting, "E3");
    assert.ok(snapshot.notes.some((note) => note.includes("module pack: viewers")), "the note is recorded");

    await progressAwaiting(ctx, "clear");
    snapshot = await progressShow(ctx);
    assert.equal(snapshot.awaiting, null);
  } finally {
    cleanup(root);
  }
});

// Helpers

