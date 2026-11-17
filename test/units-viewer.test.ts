import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInit } from "../src/agents/init.js";
import { installRefTransactionLock } from "../src/git/gitLock.js";
import {
  findFixChild,
  findFixCommit,
  parseProgress,
  readReplayMeta,
  writeReplayMeta,
  type TaskdevContext,
} from "../src/taskdev/taskdev.js";
import { isProcessAlive } from "../src/state/lock.js";
import { assertNoAgentOverreach, fileFingerprint } from "../src/orchestrator/guards-stage.js";
import { stopAgent, stopPipeline } from "../src/state/stop.js";
import { startUi, wireStartLog } from "../src/viewer/server.js";
import {
  createState,
  writeState,
} from "../src/state/store.js";
import { checkCsrf, RateLimiter, rejectIfLimited } from "../src/viewer/guards.js";
import { summary } from "../src/viewer/http.js";
import { dropStreamCache, readStreamLog } from "../src/viewer/streamCache.js";
import type { RunState } from "../src/core/types.js";
import { fullParseStream, TURN_START, TURN_DONE, fakeRequest, fakeResponse, initFixCommitFixture, fixtureCommit } from "./helpers/units-helpers.js";

test("the overreach guard fails a run whose MCP config or HEAD moved", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-overreach-"));
  const git = (args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git(["init"]);
    fs.writeFileSync(path.join(root, "f.txt"), "x\n");
    git(["add", "."]);
    git(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-m", "init"]);
    const head = git(["rev-parse", "HEAD"]);
    // A project-scope MCP config file (the descriptor shape the pipeline fingerprints).
    const mcpFile = path.join(root, ".mcp", "config.json");
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    const original = JSON.stringify({ mcp: { servers: { "github-mcp": { command: "npx" } } } }, null, 2) + "\n";
    fs.writeFileSync(mcpFile, original);
    const fingerprint = fileFingerprint(mcpFile);
    assert.match(fingerprint, /^sha256:/);
    const context = { skillDir: "/skills", id: "TASK1", workspace: root };
    const state = {
      baseCommit: head,
      taskdev: { mode: "standard" },
      mcpHashes: { [mcpFile]: fingerprint },
    } as unknown as RunState;
    assert.doesNotThrow(() => assertNoAgentOverreach(state, context));
    // The agent edited its own MCP config: caught.
    fs.writeFileSync(mcpFile, JSON.stringify({ mcp: { servers: {} } }, null, 2) + "\n");
    assert.throws(() => assertNoAgentOverreach(state, context), /MCP config changed/);
    // Config restored, but HEAD moved (the agent committed): caught.
    fs.writeFileSync(mcpFile, original);
    git(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "--allow-empty", "-m", "agent commit"]);
    assert.throws(() => assertNoAgentOverreach(state, context), /HEAD moved/);
    // A file that was absent at run start and appears mid-run: caught.
    const ghost = path.join(root, ".mcp", "ghost.json");
    const ghostState = {
      baseCommit: git(["rev-parse", "HEAD"]),
      taskdev: { mode: "standard" },
      mcpHashes: { [ghost]: "absent" },
    } as unknown as RunState;
    assert.doesNotThrow(() => assertNoAgentOverreach(ghostState, context));
    fs.writeFileSync(ghost, "{}\n");
    assert.throws(() => assertNoAgentOverreach(ghostState, context), /MCP config changed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The full-read reference parse: what a non-incremental reader would return. */

test("the stream cache parses incrementally, skips partial lines, and resets on shrink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-streamcache-"));
  const file = path.join(dir, "phase2.log");
  try {
    // Drop this path first so a sibling test cannot leak a cached entry.
    dropStreamCache(file);
    // First read: full parse of one event.
    fs.writeFileSync(file, TURN_START + "\n");
    const first = readStreamLog(file);
    assert.equal(first.exists, true);
    assert.equal(first.reset, true);
    assert.equal(first.events.length, 1);
    assert.equal(first.content, fullParseStream(file));

    // Append: only the new line is consumed; output equals a full parse.
    fs.appendFileSync(file, TURN_DONE + "\n");
    const second = readStreamLog(file);
    assert.equal(second.reset, false);
    assert.equal(second.events.length, 2);
    assert.equal(second.content, fullParseStream(file));

    // A final line without a trailing newline is not consumed yet.
    fs.appendFileSync(file, TURN_START.slice(0, 20));
    const third = readStreamLog(file);
    assert.equal(third.events.length, 2, "a growing final line must not be parsed");
    // The line completes (plus a bookkeeping line that must be filtered).
    fs.appendFileSync(file, TURN_START.slice(20) + "\n" + '{"type":"session.updated","session":"abc"}\n');
    const fourth = readStreamLog(file);
    assert.equal(fourth.events.length, 3);
    assert.equal(fourth.content, fullParseStream(file));
    assert.ok(!fourth.content.includes("session.updated"));

    // Shrink: the append-only contract broke - force a full re-parse.
    fs.writeFileSync(file, TURN_START + "\n");
    const fifth = readStreamLog(file);
    assert.equal(fifth.reset, true);
    assert.equal(fifth.events.length, 1);
    assert.equal(fifth.content, fullParseStream(file));

    // A missing file clears its cache entry and reports exists:false.
    fs.rmSync(file);
    const missing = readStreamLog(file);
    assert.equal(missing.exists, false);
    assert.equal(missing.events.length, 0);
  } finally {
    dropStreamCache(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("the CSRF guard allows same-origin and origin-less, rejects cross-origin", () => {
  const ok: Array<[string, Record<string, string> | undefined]> = [
    // curl / CLI: no Origin at all.
    ["POST", undefined],
    // The UI's own origin.
    ["POST", { origin: "http://127.0.0.1:7777", host: "127.0.0.1:7777" }],
    // Default ports: https origin vs a Host header without a port.
    ["DELETE", { origin: "https://viewer.local", host: "viewer.local" }],
    // A read is not mutating: cross-origin is fine for GET.
    ["GET", { origin: "http://evil.example", host: "127.0.0.1:7777" }],
  ];
  for (const [method, headers] of ok) {
    assert.equal(checkCsrf(fakeRequest(method, headers ?? {}), fakeResponse().response), true, `${method} ${JSON.stringify(headers)}`);
  }
  const denied: Array<[string, Record<string, string>]> = [
    // A LAN page driving the viewer.
    ["POST", { origin: "http://evil.example", host: "127.0.0.1:7777" }],
    // Same host, wrong port.
    ["POST", { origin: "http://127.0.0.1:9999", host: "127.0.0.1:7777" }],
    // Unparseable Origin.
    ["PUT", { origin: "not a url", host: "127.0.0.1:7777" }],
    // A non-web Origin protocol (file://) naming the same host is rejected
    // by the protocol check, not by the host comparison.
    ["POST", { origin: "file:///127.0.0.1", host: "127.0.0.1:7777" }],
    // Mutating request without a Host header cannot be verified.
    ["DELETE", { origin: "http://127.0.0.1:7777" }],
  ];
  for (const [method, headers] of denied) {
    assert.equal(checkCsrf(fakeRequest(method, headers), fakeResponse().response), false, `${method} ${JSON.stringify(headers)}`);
  }
});

test("the rate limiter allows the ceiling, then 429s until the window drains", () => {
  const limiter = new RateLimiter(5);
  for (let i = 0; i < 5; i += 1) assert.equal(limiter.allow("10.0.0.1"), true, `request ${i + 1}`);
  assert.equal(limiter.allow("10.0.0.1"), false, "the 6th request in the window is limited");
  // A different client is unaffected.
  assert.equal(limiter.allow("10.0.0.2"), true);
  // A disabled ceiling (0) never limits.
  const open = new RateLimiter(0);
  for (let i = 0; i < 20; i += 1) assert.equal(open.allow("10.0.0.1"), true);
  // rejectIfLimited wires the 429 to the response.
  const wire = new RateLimiter(1);
  const request = { socket: { remoteAddress: "10.0.0.9" } } as unknown as http.IncomingMessage;
  assert.equal(rejectIfLimited(wire, request, fakeResponse().response), false, "first request passes");
  const limited = fakeResponse();
  assert.equal(rejectIfLimited(wire, request, limited.response), true, "second request is rejected");
  assert.equal(limited.status, 429);
  assert.match(limited.body ?? "", /Too many requests/);
});


test("findFixCommit picks the first landed content commit, never a harness mention", async () => {
  const dir = initFixCommitFixture();
  try {
    // The TASK's real fix: subject mentions the TASK (check-in convention), touches src/.
    const fix = fixtureCommit(dir, "src/parser.ts", "TASK987654. fix the parser to handle the new field");
    // An older subject-mentioning content commit for a second TASK.
    const older = fixtureCommit(dir, "src/old.ts", "TASK987655 first landing of the fix");
    // Newer harness commit: body mentions TASK987654 — must not shadow the real fix.
    fixtureCommit(dir, "ai-flow/src/taskdev.ts", "ai-flow: viewer polish", "- task-dev: updates from the TASK987654 replay sessions");
    // Newer content commit whose subject mentions TASK987655 — oldest still wins.
    fixtureCommit(dir, "src/new.ts", "TASK987655 follow-up touching the same TASK");
    // Harness-only subject mention: not a fix for any TASK.
    fixtureCommit(dir, "ai-flow/src/other.ts", "ai-flow: TASK987657 harness support");
    // Content commit whose body-only mention must never qualify.
    fixtureCommit(dir, "src/unrelated.ts", "chore: unrelated work", "see TASK987656 notes");

    assert.equal(await findFixCommit(dir, "TASK987654"), fix, "a newer harness body mention must not shadow the real fix");
    assert.equal(await findFixCommit(dir, "TASK987655"), older, "the oldest content-touching subject mention wins");
    assert.equal(await findFixCommit(dir, "TASK987656"), null, "a body-only mention on a content commit never qualifies");
    assert.equal(await findFixCommit(dir, "TASK987657"), null, "a harness-only subject mention never qualifies");
    assert.equal(await findFixCommit(dir, "TASK999999"), null, "an unknown TASK has no fix commit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Fixture shape: the real fix lands, a later merge
// carries it forward, and the NEWEST commit mentioning the TASK is a harness
// commit that references the ticket only in its body. The anchor must be the
// real fix — and its parent (not the merge) is the pre-fix baseline.
test("findFixCommit survives the incident shape (merge parent + newest harness body mention)", async () => {
  const dir = initFixCommitFixture();
  try {
    const a0 = fixtureCommit(dir, "src/a.scm", "unrelated baseline work");
    const fix = fixtureCommit(dir, "src/b.scm", "TASK987660 - the report view crashes when the record id is not found");
    fixtureCommit(dir, "src/m.scm", "Merge branch 'feature-branch' into main");
    fixtureCommit(dir, "ai-flow/src/runner.ts", "ai-flow: fix test verdict parse + init config path, viewer/task-replay tweaks", "(fixes false 'Failed' on TASK987660)");

    assert.equal(await findFixCommit(dir, "TASK987660"), fix, "the newest harness body mention (on top of a merge) must not shadow the real fix");
    // findFixChild re-derives the fix from the (possibly re-baselined) baseline.
    assert.equal(await findFixChild(dir, "TASK987660", a0), fix, "the fix is the direct content child of the correct pre-fix baseline");
    assert.equal(await findFixChild(dir, "TASK987660", fix), null, "a child of the fix (the merge) is not itself the fix");
    assert.equal(await findFixChild(dir, "TASK987661", a0), null, "no matching child means no fix for this TASK");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseProgress exposes the replay base meta line", () => {
  assert.equal(parseProgress("phase: 1\nmode: file\nbase: fc0fd30d476cdc13e4e13f1070aeec8f675b4f8f\nawaiting:\n").base, "fc0fd30d476cdc13e4e13f1070aeec8f675b4f8f");
  assert.equal(parseProgress("phase: 1\n").base, undefined, "absent base stays undefined");
});

test("replay registry meta read/write preserves the tool-managed lines", () => {
  const prev = process.env.TASK_WORKSPACE_REGISTRY;
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-registry-"));
  process.env.TASK_WORKSPACE_REGISTRY = reg;
  const ctx: TaskdevContext = { skillDir: "/skills", id: "TASK12345", workspace: "/w" };
  try {
    assert.equal(readReplayMeta(ctx), null, "no entry before init");
    writeReplayMeta(ctx, { fix: "aa806e32", baseline: "af725be8" });
    let meta = readReplayMeta(ctx);
    assert.ok(meta && meta.fix === "aa806e32" && meta.baseline === "af725be8");
    // A tool-written entry also carries repo=/root=; adopting a re-baseline
    // must update only fix=/baseline= and keep the rest byte-for-byte.
    fs.writeFileSync(path.join(reg, "replay-TASK12345.meta"), "fix=aa806e32\nbaseline=af725be8\nrepo=/w/project\nroot=/proj\n", "utf8");
    writeReplayMeta(ctx, { fix: "d9d7fc78", baseline: "fc0fd30d" });
    meta = readReplayMeta(ctx);
    assert.ok(meta && meta.fix === "d9d7fc78" && meta.baseline === "fc0fd30d" && meta.repo === "/w/project" && meta.root === "/proj");
  } finally {
    if (prev === undefined) delete process.env.TASK_WORKSPACE_REGISTRY;
    else process.env.TASK_WORKSPACE_REGISTRY = prev;
    fs.rmSync(reg, { recursive: true, force: true });
  }
});

test("summary flags generic-pack runs (no scope guard)", () => {
  const base = (over: Partial<RunState>): RunState => ({
    id: "TASK1",
    status: "running",
    stage: "phase1",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    worktree: "/w",
    baseCommit: "abc",
    stages: {} as never,
    artifacts: {},
    taskdev: { mode: "standard", workspace: "/w" },
    error: null,
    ...over,
  });
  assert.equal(summary(base({})).genericPack, true, "no recorded pack falls back to the generic adapter");
  assert.equal(summary(base({ taskdev: { mode: "standard", workspace: "/w", pack: "viewers" } })).genericPack, false, "viewers has a dedicated adapter");
  assert.equal(summary(base({ taskdev: { mode: "standard", workspace: "/w", pack: "generic" } })).genericPack, true);
  assert.equal(summary(base({ taskdev: { mode: "standard", workspace: "/w", pack: "somefuturepack" } })).genericPack, true, "an unadapted pack must be flagged");
});

// Stop: leaked ref-lock hook, process-group kill

test("stopPipeline removes the leaked git ref-lock hook from the run's workspace", async () => {
  // around each agent phase and removes it in a finally block. A pipeline
  // killed with SIGKILL never reaches that finally, and the leaked hook
  // then blocked the operator's own manual commits in the workspace.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-stop-reflock-"));
  const git = (args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git(["init", "-q"]);
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    git(["add", "."]);
    git(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "base"]);
    // A pre-existing user hook that a clean stop must restore byte-for-byte.
    const hooksDir = path.resolve(root, git(["rev-parse", "--git-dir"]), "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "reference-transaction");
    const userHook = "#!/bin/sh\n# user hook\nexit 0\n";
    fs.writeFileSync(hookPath, userHook);

    const runDir = path.join(root, ".ai-flow", "runs", "TASK77999");
    fs.mkdirSync(runDir, { recursive: true });
    writeState(runDir, {
      ...createState("TASK77999", root, "x"),
      taskdev: { mode: "standard", workspace: root, gates: {} },
    });
    // Simulate a pipeline that died mid-phase (its finally never ran).
    assert.equal(installRefTransactionLock(root), true);
    assert.match(fs.readFileSync(hookPath, "utf8"), /ai-flow reference-transaction ref lock/);

    // The command has no {cwd} token, so the only pkill pattern is the
    // ticket-anchored CLI one — it cannot match this test process.
    await stopPipeline(runDir, { runner: { command: ["fake-agent-never-alive", "{promptFile}"] } }, "TASK77999");

    assert.equal(fs.readFileSync(hookPath, "utf8"), userHook, "the user hook is restored byte-for-byte");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stopAgent kills the agent's whole process group, not just its pid", async () => {
  // so stop must signal the group — a bare pid kill leaves the agent's own
  // children (a test harness, a linter) running in the workspace.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-stopgroup-"));
  const grandFile = path.join(dir, "grandchild.pid");
  // A fake agent script, run as `bash <script>` (as the runner spawns the
  // configured command): it starts a grandchild a bare pid kill would not
  // reach, then keeps running. It is a script FILE (not `bash -c`) with a
  // trailing `exit 0`, because bash execs a -c script's last command in
  // place — which would replace the agent's cmdline and break the
  // cmdline-verified pid check. A cold spawn under load can take a while,
  // so the grandchild file is polled instead of using a fixed sleep.
  const script = path.join(dir, "agent.sh");
  fs.writeFileSync(script, `sleep 300 &\necho $! > ${grandFile}\nsleep 300\nexit 0\n`);
  const child = spawn("bash", [script], { stdio: "ignore", detached: true });
  try {
    const pid = child.pid;
    assert.ok(pid, "the fake agent has a pid");
    let grandchild = 0;
    for (let i = 0; i < 50; i += 1) {
      if (fs.existsSync(grandFile)) {
        grandchild = Number(fs.readFileSync(grandFile, "utf8").trim());
        if (grandchild > 0) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(grandchild > 0, "the fake agent started its grandchild");

    fs.writeFileSync(path.join(dir, "agent.pid"), String(pid));
    const outcome = await stopAgent(dir, { runner: { command: ["bash", "-c", "x"] } });
    assert.equal(outcome.killed, true);

    for (let i = 0; i < 50 && isProcessAlive(grandchild); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(isProcessAlive(grandchild), false, "the grandchild must die with the agent's process group");
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("a start-log disk error does not back-pressure the detached pipeline", async () => {
  // the error while the pipe kept flowing into a dead stream — back-pressure
  // stalled the pipeline's stdout once the pipe buffer filled, hanging a run
  // whose log path happened to be a directory (or the disk filled).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-startlog-err-"));
  // Pre-create the log path as a DIRECTORY: the write stream fails on open
  // (EISDIR), the exact failure mode a colliding path or corrupt logs dir hits.
  const logPath = path.join(dir, "start-TASK1.log");
  fs.mkdirSync(logPath);
  // The child must write well past the pipe buffer: without the fix it would
  // stall on the full pipe and never reach the final exit(0).
  const child = spawn(
    process.execPath,
    [
      "-e",
      "let n = 0; const iv = setInterval(() => { process.stdout.write('x'.repeat(65536)); if (++n >= 50) { clearInterval(iv); process.exit(0); } }, 5);",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr?.resume();
  wireStartLog(child, logPath);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the child stalled on a broken start log (backpressure)")), 15000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`the child exited ${code}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createRun waits the longer window while a recorded pipeline pid is alive", async () => {
  // With a recorded LIVE pid the window is START_WAIT_MS_WITH_PID (a slow
  // preflight is normal); with no pid it stays START_WAIT_MS. A dead pid
  // still short-circuits immediately. The env override keeps this fast.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-livewait-"));
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const prevWithPid = process.env.AI_FLOW_START_WAIT_MS_WITH_PID;
  process.env.AI_FLOW_START_WAIT_MS_WITH_PID = "1200";
  let server: http.Server | undefined;
  try {
    server = await startUi(root, "127.0.0.1", 0, {
      startRun: (_repoRoot, id) => {
        const logDir = path.join(_repoRoot, ".ai-flow", "logs");
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(path.join(logDir, `start-${id}.pgid`), String(child.pid ?? 1));
      },
    });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    const startedAt = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "88442" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; started: boolean; error?: string };
    assert.equal(body.started, false);
    // No pid-dead wording (the pid is alive) — the "still starting" message
    // after the live window, which is longer than the 500ms no-pid default.
    assert.match(body.error ?? "", /may still be starting/);
    assert.ok(Date.now() - startedAt >= 1000, "the live-pid window must be waited out");
  } finally {
    if (prevWithPid === undefined) delete process.env.AI_FLOW_START_WAIT_MS_WITH_PID;
    else process.env.AI_FLOW_START_WAIT_MS_WITH_PID = prevWithPid;
    if (child.pid) process.kill(child.pid);
    const closingServer = server;
    if (closingServer) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 2000);
        closingServer.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// init: runner customization survives re-init

test("init preserves a legacy custom runner.command and user-set runner fields across re-init", async () => {
  // dropped a legacy (pre-agent) hand-tuned command and the user's modelFlag /
  // modelsCommand / statusCommand / versionCheck.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-init-legacy-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-init-home-"));
  try {
    // A legacy file: no `agent` (pre-agent shape), a hand-tuned command.
    fs.writeFileSync(
      path.join(root, "ai-flow.config.json"),
      JSON.stringify({
        runner: {
          command: ["myagent", "--flag", "{promptStdin}"],
          modelFlag: "--model-id",
          modelsCommand: ["myagent", "models"],
          statusCommand: ["stat.sh", "{dir}"],
          versionCheck: "^1\\.",
        },
        ui: { host: "127.0.0.1", port: 4190 },
        taskdev: { pack: "viewers" },
      }),
    );
    const lines: string[] = [];
    const result = await runInit({
      repoRoot: root,
      agent: "deepseek",
      model: "deepseek-v4",
      yes: true,
      installed: () => false,
      // Hermetic resolution: no PATH, empty HOME — dsh cannot be found.
      env: { ...process.env, HOME: home, PATH: "" },
      log: (line) => lines.push(line),
    });
    const written = JSON.parse(fs.readFileSync(result.file, "utf8")) as {
      agent: string;
      model: string;
      runner: { command: string[]; modelFlag: string; modelsCommand: string[]; statusCommand: string[]; versionCheck: string };
      ui: { port: number };
      taskdev: { pack: string };
    };
    assert.deepEqual(written.runner.command, ["myagent", "--flag", "{promptStdin}"], "the custom command survives re-init");
    assert.equal(written.runner.modelFlag, "--model-id");
    assert.deepEqual(written.runner.modelsCommand, ["myagent", "models"]);
    assert.deepEqual(written.runner.statusCommand, ["stat.sh", "{dir}"]);
    assert.equal(written.runner.versionCheck, "^1\\.");
    assert.equal(written.agent, "deepseek");
    assert.equal(written.model, "deepseek-v4");
    assert.equal(written.ui.port, 4190);
    assert.equal(written.taskdev.pack, "viewers");
    assert.match(lines.join("\n"), /Kept the existing custom runner\.command/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("init refreshes an unchanged preset command on re-init and never keeps a previous agent's command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-init-refresh-"));
  const init = async (agent: string): Promise<string> => {
    const result = await runInit({
      repoRoot: root,
      agent,
      model: "",
      yes: true,
      installed: () => true,
      log: () => undefined,
    });
    return fs.readFileSync(result.file, "utf8");
  };
  const read = (text: string): { agent: string; runner: { command: string[] } } => JSON.parse(text) as {
    agent: string;
    runner: { command: string[] };
  };
  try {
    // First init writes the resolved preset command.
    const first = read(await init("claude"));
    const resolved = first.runner.command;
    assert.ok(resolved.length > 0, "the preset command is present");

    // Same agent, untouched command: re-init keeps it.
    const second = read(await init("claude"));
    assert.deepEqual(second.runner.command, resolved, "an unchanged preset command stays the resolved one");

    // Same agent, a hand-tuned tweak: the tweak survives the re-init.
    const tweaked = JSON.parse(JSON.stringify(first));
    tweaked.runner.command = [resolved[0], "--extra", ...resolved.slice(1)];
    fs.writeFileSync(path.join(root, "ai-flow.config.json"), JSON.stringify(tweaked, null, 2));
    const third = read(await init("claude"));
    assert.deepEqual(third.runner.command, tweaked.runner.command, "a customized command survives the re-init");

    // A DIFFERENT previous agent's command is never carried over: the new
    // preset owns the invocation.
    fs.writeFileSync(
      path.join(root, "ai-flow.config.json"),
      JSON.stringify({ agent: "claude", runner: { command: ["totally", "different", "command"] } }, null, 2),
    );
    const fourth = read(await init("deepseek"));
    assert.equal(fourth.agent, "deepseek");
    assert.ok(fourth.runner.command[0].endsWith("dsh"), "switching agents replaces the stale previous command");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("viewer package download: an unreadable tarball destroys the response, not the process", async () => {
  // A read-stream failure (the tarball archived by a concurrent phase 4 between
  // the stat and the open, EACCES, EMFILE) is an ASYNCHRONOUS 'error' event on
  // the ReadStream — without a listener it is an uncaughtException that kills
  // the whole viewer process, taking every other client down. The response must
  // be destroyed and the viewer must survive.
  if (typeof process.getuid === "function" && process.getuid() === 0) return; // root reads a 000 file fine
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-pkg-err-"));
  const prevPkgDir = process.env.TASK_PACKAGE_DIR;
  process.env.TASK_PACKAGE_DIR = path.join(root, "packages");
  try {
    const runDir = path.join(root, ".ai-flow", "runs", "7");
    fs.mkdirSync(runDir, { recursive: true });
    const tarPath = path.join(root, "packages", "7_202610191200.tar.gz");
    fs.mkdirSync(path.dirname(tarPath), { recursive: true });
    fs.writeFileSync(tarPath, "not a real tarball");
    // statSync succeeds on a 000 file (no read bit needed), so the route
    // reaches the stream; the open then fails with EACCES.
    fs.chmodSync(tarPath, 0o000);
    const state = createState("7", root, "abc");
    state.artifacts.package = tarPath;
    writeState(runDir, state);

    const server = await startUi(root, "127.0.0.1", 0, { startRun: () => undefined });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    try {
      let downloadFailed = false;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/runs/7/package`);
        downloadFailed = (await res.text()).length === 0;
      } catch {
        downloadFailed = true; // reset connection
      }
      assert.ok(downloadFailed, "the unreadable tarball must not be served as content");
      // The regression: the viewer process survives the stream error.
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200, "the viewer must stay up");
      const runs = await fetch(`http://127.0.0.1:${port}/api/runs`);
      assert.equal(runs.status, 200, "other endpoints keep working");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    if (prevPkgDir === undefined) delete process.env.TASK_PACKAGE_DIR;
    else process.env.TASK_PACKAGE_DIR = prevPkgDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
