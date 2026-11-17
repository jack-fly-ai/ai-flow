import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StageError } from "../src/core/errors.js";
import { runAgent } from "../src/agents/runner.js";
import { startUi } from "../src/viewer/server.js";

test("runner reports a missing command as startup failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-runner-"));
  const prompt = path.join(dir, "prompt.md");
  fs.writeFileSync(prompt, "hello");
  await assert.rejects(
    () =>
      runAgent({
        command: ["ai-flow-missing-bin", "{promptFile}"],
        cwd: dir,
        promptFile: prompt,
        logFile: path.join(dir, "agent.log"),
      }),
    (err: unknown) => err instanceof StageError && err.kind === "startup",
  );
});

test("runner accepts a local process that writes the expected file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-runner-"));
  const prompt = path.join(dir, "prompt.md");
  const output = path.join(dir, "out.md");
  fs.writeFileSync(prompt, "hello");
  const agent = path.join(dir, "agent.mjs");
  fs.writeFileSync(agent, "import fs from 'node:fs'; fs.writeFileSync(process.argv[3], 'done\\n');\n");
  const result = await runAgent({
    command: [process.execPath, agent, "{promptFile}", output],
    cwd: dir,
    promptFile: prompt,
    logFile: path.join(dir, "agent.log"),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(fs.readFileSync(output, "utf8"), "done\n");
});


test("ui lists task-dev state, serves state docs, and handles gate-4 plus escalation reviews", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-"));
  // The package download is restricted to the pipeline's package directory.
  const prevPkgDir = process.env.TASK_PACKAGE_DIR;
  process.env.TASK_PACKAGE_DIR = root;
  const restorePkgDir = (): void => {
    if (prevPkgDir === undefined) delete process.env.TASK_PACKAGE_DIR;
    else process.env.TASK_PACKAGE_DIR = prevPkgDir;
  };
  const packageFile = path.join(root, "3_202609281200.tar.gz");
  fs.writeFileSync(packageFile, "fake-tar");
  const workspace = root;
  const stateDir = path.join(workspace, ".task-dev", "3");
  fs.mkdirSync(path.join(stateDir, "deliverables"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "phase1-requirement.md"), "# Requirement\n");
  fs.writeFileSync(path.join(stateDir, "deliverables", "clarification-comments.md"), "Question?\n");
  fs.mkdirSync(path.join(root, ".ai-flow", "runs", "3"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".ai-flow", "runs", "3", "state.json"),
    JSON.stringify({
      id: "3",
      status: "awaiting_review",
      stage: "review",
      startedAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
      baseCommit: "abc",
      worktree: workspace,
      stages: { review: { status: "awaiting_review" } },
      artifacts: { package: packageFile },
      taskdev: { mode: "standard", workspace, gates: { 1: "passed", 2: "passed", 3: "passed", 4: "pending" }, phase: 4 },
      awaiting: { kind: "gate4" },
      error: null,
    }),
  );
  const started: string[] = [];
  const server = await startUi(root, "127.0.0.1", 0, {
    startRun: (_repoRoot, id) => {
      started.push(id);
      // Simulate the pipeline having written its initial state file for a fresh run.
      const stateFile = path.join(_repoRoot, ".ai-flow", "runs", id, "state.json");
      if (!fs.existsSync(stateFile)) {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(
          stateFile,
          JSON.stringify({
            id,
            status: "running",
            stage: "fetch",
            startedAt: "2026-09-23T00:00:00.000Z",
            updatedAt: "2026-09-23T00:00:00.000Z",
            baseCommit: "abc",
            worktree: root,
            stages: { fetch: { status: "running" } },
            artifacts: {},
            error: null,
          }),
        );
      }
    },
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    const listed = await fetch(`http://127.0.0.1:${port}/api/runs`);
    const body = (await listed.json()) as { runs: Array<{ id: string; mode: string | null; gates: Record<string, string> | null }> };
    assert.equal(body.runs[0]?.id, "3");
    assert.equal(body.runs[0]?.mode, "standard");
    assert.equal(body.runs[0]?.gates?.[1], "passed");

    const detail = await fetch(`http://127.0.0.1:${port}/api/runs/3`);
    const page = (await detail.json()) as { docs: { requirement: { ready: boolean }; clarifications: { ready: boolean } } };
    assert.equal(page.docs.requirement.ready, true);
    assert.equal(page.docs.clarifications.ready, true);

    const approved = await fetch(`http://127.0.0.1:${port}/api/runs/3/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(approved.status, 200);
    const approvedState = JSON.parse(fs.readFileSync(path.join(root, ".ai-flow", "runs", "3", "state.json"), "utf8")) as { status: string };
    assert.equal(approvedState.status, "approved");

    // An escalation answer resumes the phase with the answer injected.
    const escalationDir = path.join(root, ".ai-flow", "runs", "5");
    fs.mkdirSync(escalationDir, { recursive: true });
    fs.writeFileSync(
      path.join(escalationDir, "state.json"),
      JSON.stringify({
        id: "5",
        status: "awaiting_review",
        stage: "phase1",
        startedAt: "2026-09-28T00:00:00.000Z",
        updatedAt: "2026-09-28T00:00:00.000Z",
        baseCommit: "abc",
        worktree: workspace,
        stages: { phase1: { status: "awaiting_review" } },
        artifacts: {},
        taskdev: { mode: "standard", workspace, gates: {} },
        awaiting: { kind: "clarification", code: "E1" },
        error: null,
      }),
    );
    const answered = await fetch(`http://127.0.0.1:${port}/api/runs/5/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", comment: "Use the shared pool" }),
    });
    assert.equal(answered.status, 202);
    assert.deepEqual(await answered.json(), { id: "5", resumedFrom: "phase1" });
    assert.equal(started.at(-1), "5");
    const escalationState = JSON.parse(fs.readFileSync(path.join(escalationDir, "state.json"), "utf8")) as {
      rework: { stage: string; comment: string };
    };
    assert.equal(escalationState.rework.stage, "phase1");
    assert.equal(escalationState.rework.comment, "Use the shared pool");

    // Gate-4 rejection rewinds to a phase.
    const rejectDir = path.join(root, ".ai-flow", "runs", "7");
    fs.mkdirSync(rejectDir, { recursive: true });
    fs.writeFileSync(
      path.join(rejectDir, "state.json"),
      JSON.stringify({
        id: "7",
        status: "awaiting_review",
        stage: "review",
        startedAt: "2026-09-28T00:00:00.000Z",
        updatedAt: "2026-09-28T00:00:00.000Z",
        baseCommit: "abc",
        worktree: workspace,
        stages: { review: { status: "awaiting_review" } },
        artifacts: {},
        taskdev: { mode: "standard", workspace, gates: {} },
        awaiting: { kind: "gate4" },
        error: null,
      }),
    );
    const badStage = await fetch(`http://127.0.0.1:${port}/api/runs/7/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", stage: "implement", comment: "x" }),
    });
    assert.equal(badStage.status, 400);
    const rejected = await fetch(`http://127.0.0.1:${port}/api/runs/7/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", stage: "phase2", comment: "Wrong approach" }),
    });
    assert.equal(rejected.status, 202);
    assert.deepEqual(await rejected.json(), { id: "7", resumedFrom: "phase2" });
    assert.equal(started.at(-1), "7");

    const downloaded = await fetch(`http://127.0.0.1:${port}/api/runs/3/package`);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "application/gzip");
    assert.match(downloaded.headers.get("content-disposition") ?? "", /3_202609281200\.tar\.gz/);

    // A failed run can be deleted (record, task-dev state, replay tree).
    fs.mkdirSync(path.join(root, ".ai-flow", "runs", "9"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".ai-flow", "runs", "9", "state.json"),
      JSON.stringify({
        id: "9",
        status: "failed",
        stage: "phase3",
        startedAt: "2026-09-28T00:00:00.000Z",
        updatedAt: "2026-09-28T00:00:00.000Z",
        baseCommit: "abc",
        worktree: workspace,
        stages: { phase3: { status: "failed" } },
        artifacts: {},
        taskdev: { mode: "standard", workspace, gates: {} },
        error: "boom",
      }),
    );
    const removed = await fetch(`http://127.0.0.1:${port}/api/runs/9`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { id: "9", deleted: true });
    assert.equal(fs.existsSync(path.join(root, ".ai-flow", "runs", "9")), false);
    const afterDelete = (await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json()) as { runs: Array<{ id: string }> };
    assert.equal(afterDelete.runs.some((run) => run.id === "9"), false);

    const missingDelete = await fetch(`http://127.0.0.1:${port}/api/runs/TASK1`, { method: "DELETE" });
    assert.equal(missingDelete.status, 404);

    const denied = await fetch(`http://127.0.0.1:${port}/api/runs`, { method: "PUT" });
    assert.equal(denied.status, 405);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    restorePkgDir();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ui token auth: 401 without, 200 with Bearer or ?token=, static included", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-token-"));
  try {
    fs.writeFileSync(
      path.join(root, "ai-flow.config.json"),
      JSON.stringify({ runner: { command: ["fake-agent", "{promptFile}"] }, ui: { token: "s3cret-token" } }),
    );
    const server = await startUi(root, "127.0.0.1", 0, { startRun: () => undefined });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    try {
      const noToken = await fetch(`http://127.0.0.1:${port}/api/runs`);
      assert.equal(noToken.status, 401);
      const wrongToken = await fetch(`http://127.0.0.1:${port}/api/runs`, { headers: { authorization: "Bearer wrong" } });
      assert.equal(wrongToken.status, 401);
      const bearer = await fetch(`http://127.0.0.1:${port}/api/runs`, { headers: { authorization: "Bearer s3cret-token" } });
      assert.equal(bearer.status, 200);
      const query = await fetch(`http://127.0.0.1:${port}/api/runs?token=s3cret-token`);
      assert.equal(query.status, 200);
      // Static assets are behind the same check.
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.notEqual(page.status, 200);
      assert.equal(page.status, 401);
      const pageWithToken = await fetch(`http://127.0.0.1:${port}/?token=s3cret-token`);
      assert.notEqual(pageWithToken.status, 401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ui rejects cross-origin mutating requests and rate-limits bursts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-guard-"));
  try {
    // A low ceiling so the burst is short: 12 requests/minute.
    fs.writeFileSync(
      path.join(root, "ai-flow.config.json"),
      JSON.stringify({ runner: { command: ["fake-agent", "{promptFile}"] }, ui: { rateLimitPerMinute: 12 } }),
    );
    const server = await startUi(root, "127.0.0.1", 0, { startRun: () => undefined });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    try {
      // CSRF: a cross-origin DELETE is refused before the route runs...
      const crossOrigin = await fetch(`http://127.0.0.1:${port}/api/runs/TASK1`, {
        method: "DELETE",
        headers: { origin: "http://evil.example" },
      });
      assert.equal(crossOrigin.status, 403);
      // ...a same-origin DELETE reaches the route (404: no such run)...
      const sameOrigin = await fetch(`http://127.0.0.1:${port}/api/runs/TASK1`, {
        method: "DELETE",
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      assert.equal(sameOrigin.status, 404);
      // ...and so does an origin-less (curl-style) one.
      const noOrigin = await fetch(`http://127.0.0.1:${port}/api/runs/TASK1`, { method: "DELETE" });
      assert.equal(noOrigin.status, 404);
      // Rate limit: GETs up to the ceiling pass, the next one is 429.
      let limited: number | null = null;
      for (let i = 0; i < 14; i += 1) {
        const response = await fetch(`http://127.0.0.1:${port}/api/runs`);
        if (response.status === 429) {
          limited = i;
          break;
        }
        assert.equal(response.status, 200, `request ${i} should pass the limit`);
      }
      assert.notEqual(limited, null, "the burst must eventually be limited");
      assert.ok((limited ?? 0) <= 12, "the ceiling is 12 requests/minute");
      const body = (await fetch(`http://127.0.0.1:${port}/api/runs`)).status;
      assert.equal(body, 429, "the client stays limited inside the window");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ui rejects oversized request bodies with 413 and keeps the process up", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-413-"));
  const server = await startUi(root, "127.0.0.1", 0, { startRun: () => undefined });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    // Beyond the 1MB body cap: a 413, not an OOM or a 400.
    const big = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "TASK1", pad: "x".repeat(2 * 1024 * 1024) }),
    });
    assert.equal(big.status, 413);
    // The viewer process survived the oversized body.
    const alive = await fetch(`http://127.0.0.1:${port}/api/runs`);
    assert.equal(alive.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ui package download refuses paths outside the package directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-pkg-"));
  const prevPkgDir = process.env.TASK_PACKAGE_DIR;
  process.env.TASK_PACKAGE_DIR = path.join(root, "packages");
  const restorePkgDir = (): void => {
    if (prevPkgDir === undefined) delete process.env.TASK_PACKAGE_DIR;
    else process.env.TASK_PACKAGE_DIR = prevPkgDir;
  };
  const elsewhere = path.join(root, "elsewhere", "8_202609281200.tar.gz");
  fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
  fs.writeFileSync(elsewhere, "sensitive");
  fs.mkdirSync(path.join(root, ".ai-flow", "runs", "8"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".ai-flow", "runs", "8", "state.json"),
    JSON.stringify({
      id: "8",
      status: "awaiting_review",
      stage: "review",
      startedAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
      baseCommit: "abc",
      worktree: root,
      stages: { review: { status: "awaiting_review" } },
      artifacts: { package: elsewhere },
      error: null,
    }),
  );
  const server = await startUi(root, "127.0.0.1", 0, { startRun: () => undefined });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    // state.artifacts.package pointing outside the package dir: 404, no leak.
    const denied = await fetch(`http://127.0.0.1:${port}/api/runs/8/package`);
    assert.equal(denied.status, 404);
    // A tarball properly placed in the package dir is served.
    const good = path.join(root, "packages", "8_202609281200.tar.gz");
    fs.mkdirSync(path.dirname(good), { recursive: true });
    fs.writeFileSync(good, "fake-tar");
    const stateFile = path.join(root, ".ai-flow", "runs", "8", "state.json");
    const st = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { artifacts: { package?: string } };
    st.artifacts.package = good;
    fs.writeFileSync(stateFile, JSON.stringify(st));
    const ok = await fetch(`http://127.0.0.1:${port}/api/runs/8/package`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "fake-tar");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    restorePkgDir();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ui serves the run's patch from inside the run dir, refusing a tampered path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-patch-"));
  try {
    fs.mkdirSync(path.join(root, ".ai-flow", "runs", "8"), { recursive: true });
    // A patch path pointing outside the run dir must not be served (no leak),
    // even when a file exists at that resolved location.
    fs.writeFileSync(
      path.join(root, ".ai-flow", "runs", "8", "state.json"),
      JSON.stringify({
        id: "8",
        status: "awaiting_review",
        stage: "review",
        startedAt: "2026-09-28T00:00:00.000Z",
        updatedAt: "2026-09-28T00:00:00.000Z",
        baseCommit: "abc",
        worktree: root,
        stages: { review: { status: "awaiting_review" } },
        artifacts: { patch: "../escaped.patch" },
        error: null,
      }),
    );
    fs.writeFileSync(path.join(root, ".ai-flow", "escaped.patch"), "should-not-leak");
    const server = await startUi(root, "127.0.0.1", 0, { startRun: () => undefined });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    try {
      const denied = await fetch(`http://127.0.0.1:${port}/api/runs/8/patch`);
      assert.equal(denied.status, 404);
      // A real patch placed inside the run dir IS served.
      const good = path.join(root, ".ai-flow", "runs", "8", "changes.patch");
      fs.writeFileSync(good, "diff --git a/x b/x");
      const stateFile = path.join(root, ".ai-flow", "runs", "8", "state.json");
      const st = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { artifacts: { patch?: string } };
      st.artifacts.patch = "changes.patch";
      fs.writeFileSync(stateFile, JSON.stringify(st));
      const ok = await fetch(`http://127.0.0.1:${port}/api/runs/8/patch`);
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("content-type"), "text/x-patch");
      assert.match(ok.headers.get("content-disposition") ?? "", /changes\.patch/);
      assert.equal(await ok.text(), "diff --git a/x b/x");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ui reports an immediate startup failure instead of a fake success", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-fail-"));
  const server = await startUi(root, "127.0.0.1", 0, {
    startRun: (_repoRoot, id) => {
      // Simulate a runner that fails preflight before writing a state file.
      const logDir = path.join(_repoRoot, ".ai-flow", "logs");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, `start-${id}.log`),
        "Runner preflight failed: configured agent command 'fake-agent' was not found.\n",
      );
    },
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "11111" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; started: boolean; error?: string };
    assert.equal(body.id, "11111");
    assert.equal(body.started, false);
    assert.match(body.error ?? "", /fake-agent/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ui createRun fast-fails when the pipeline pid is already dead", async () => {
  // spawned pipeline had already exited, making immediate startup failures
  // look like a hang. The viewer now records the child pid in
  // start-<id>.pgid; a dead pid short-circuits the wait and the start log
  // error is surfaced at once.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-deadpid-"));
  // A real, verifiably dead pid: spawn `true` and wait for its exit.
  const deadPid: number = await new Promise((resolve, reject) => {
    const child = spawn("true", { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", () => {
      if (child.pid === undefined) reject(new Error("no pid"));
      else resolve(child.pid);
    });
  });
  const server = await startUi(root, "127.0.0.1", 0, {
    startRun: (_repoRoot, id) => {
      const logDir = path.join(_repoRoot, ".ai-flow", "logs");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, `start-${id}.log`), "Error: Cannot find module '/repo/ai-flow/dist/cli.js'\n");
      fs.writeFileSync(path.join(logDir, `start-${id}.pgid`), String(deadPid));
    },
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    const startedAt = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "34446" }),
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; started: boolean; error?: string };
    assert.equal(body.id, "34446");
    assert.equal(body.started, false);
    assert.match(body.error ?? "", /Cannot find module/);
    // The default window is 5s; a dead pid must answer in a fraction of it.
    assert.ok(elapsed < 4000, `dead pid must short-circuit the wait (took ${elapsed}ms)`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ui createRun: 202 only after the spawned pipeline ADVANCES the record (rev)", async () => {
  // Retry the previous run's record is still on disk, so a spawn that died in
  // milliseconds was reported as 202 resumed while the run was still failed.
  // The record must now ADVANCE (rev past the pre-spawn snapshot).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-rev-"));
  const runDir = path.join(root, ".ai-flow", "runs", "11");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "state.json"),
    JSON.stringify({
      id: "11",
      rev: 7,
      status: "failed",
      stage: "phase2",
      startedAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
      baseCommit: "abc",
      worktree: root,
      stages: { phase2: { status: "failed" } },
      artifacts: {},
      taskdev: { mode: "standard", workspace: root, gates: {} },
      error: "boom",
    }),
  );
  const server = await startUi(root, "127.0.0.1", 0, {
    // The spawned pipeline starts, then advances the record (rev 7 -> 8),
    // exactly like runPipeline's first writeState on resume.
    startRun: (_repoRoot, id) => {
      setTimeout(() => {
        fs.writeFileSync(
          path.join(_repoRoot, ".ai-flow", "runs", id, "state.json"),
          JSON.stringify({
            id,
            rev: 8,
            status: "running",
            stage: "phase2",
            startedAt: "2026-09-28T00:00:00.000Z",
            updatedAt: "2026-09-28T00:00:00.000Z",
            baseCommit: "abc",
            worktree: _repoRoot,
            stages: { phase2: { status: "running" } },
            artifacts: {},
            taskdev: { mode: "standard", workspace: _repoRoot, gates: {} },
            error: null,
          }),
        );
      }, 100);
    },
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "11" }),
    });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { id: "11" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ui createRun: a Retry whose spawn dies without writing is NOT reported as started", async () => {
  // The companion to the test above: a prior failed record (rev 7) satisfies
  // "file exists" instantly, but the dead pipeline never advances it — the
  // answer must be the real failure, not 202. AI_FLOW_START_WAIT_MS shrinks
  // the window so the test stays fast.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-rev-"));
  const runDir = path.join(root, ".ai-flow", "runs", "12");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "state.json"),
    JSON.stringify({
      id: "12",
      rev: 7,
      status: "failed",
      stage: "phase3",
      startedAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
      baseCommit: "abc",
      worktree: root,
      stages: { phase3: { status: "failed" } },
      artifacts: {},
      taskdev: { mode: "standard", workspace: root, gates: {} },
      error: "boom",
    }),
  );
  const prevWait = process.env.AI_FLOW_START_WAIT_MS;
  process.env.AI_FLOW_START_WAIT_MS = "300";
  const server = await startUi(root, "127.0.0.1", 0, {
    // The spawn dies instantly and writes NOTHING (bad agent command).
    startRun: () => undefined,
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "12" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; started: boolean; error?: string };
    assert.equal(body.started, false, "a spawn that never advanced the record must not report started");
    assert.match(body.error ?? "", /may still be starting|exited during startup/);
    // The record on disk is untouched: still the failed rev-7 record.
    const onDisk = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8")) as { rev: number; status: string };
    assert.equal(onDisk.rev, 7);
    assert.equal(onDisk.status, "failed");
  } finally {
    if (prevWait === undefined) delete process.env.AI_FLOW_START_WAIT_MS;
    else process.env.AI_FLOW_START_WAIT_MS = prevWait;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ui createRun: a Retry during the rework window is refused, not double-spawned", async () => {
  // After a human message / reject / escalation answer the record carries
  // `rework` and a spawned pipeline is already consuming it. A second Retry in
  // confusing "exited during startup" — it must be a 409 with no spawn at all.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-rework-"));
  const runDir = path.join(root, ".ai-flow", "runs", "13");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "state.json"),
    JSON.stringify({
      id: "13",
      rev: 7,
      status: "failed",
      stage: "phase2",
      startedAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
      baseCommit: "abc",
      worktree: root,
      stages: { phase2: { status: "failed" } },
      artifacts: {},
      taskdev: { mode: "standard", workspace: root, gates: {} },
      error: "boom",
      rework: { stage: "phase2", comment: "use the reviewed bytes", at: "2026-09-28T00:00:01.000Z" },
    }),
  );
  // A verifiably LIVE consumer: a real child process whose pid the viewer
  // would have recorded in start-13.pgid when it spawned the resume.
  const liveConsumer = spawn("sleep", ["30"], { stdio: "ignore" });
  const logDir = path.join(root, ".ai-flow", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "start-13.pgid"), String(liveConsumer.pid));
  let spawns = 0;
  const server = await startUi(root, "127.0.0.1", 0, {
    startRun: () => {
      spawns += 1;
    },
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "13" }),
    });
    assert.equal(res.status, 409, "a live consumer makes the run un-startable until it finishes");
    assert.equal(spawns, 0, "no second pipeline may be spawned");
  } finally {
    liveConsumer.kill();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ui createRun: a rework left behind by a crashed resume does NOT lock the Retry", async () => {
  // The companion: the consuming pipeline died before clearing `rework` (its
  // recorded pgid is gone). The rework is pending guidance, not a lock — the
  // retry must proceed and re-inject it, exactly like the CLI resume path.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-rework-dead-"));
  const runDir = path.join(root, ".ai-flow", "runs", "14");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "state.json"),
    JSON.stringify({
      id: "14",
      rev: 7,
      status: "failed",
      stage: "phase2",
      startedAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
      baseCommit: "abc",
      worktree: root,
      stages: { phase2: { status: "failed" } },
      artifacts: {},
      taskdev: { mode: "standard", workspace: root, gates: {} },
      error: "boom",
      rework: { stage: "phase2", comment: "use the reviewed bytes", at: "2026-09-28T00:00:01.000Z" },
    }),
  );
  const deadPid: number = await new Promise((resolve, reject) => {
    const child = spawn("true", { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", () => {
      if (child.pid === undefined) reject(new Error("no pid"));
      else resolve(child.pid);
    });
  });
  const logDir = path.join(root, ".ai-flow", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "start-14.pgid"), String(deadPid));
  fs.writeFileSync(path.join(logDir, "start-14.log"), "killed\n");
  let spawns = 0;
  const server = await startUi(root, "127.0.0.1", 0, {
    startRun: () => {
      spawns += 1;
    },
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "14" }),
    });
    // The dead consumer short-circuits the wait; the answer is the honest
    // "nothing started" — NOT a 409 that would lock the operator out.
    assert.equal(res.status, 200);
    assert.equal(spawns, 1, "the retry proceeds so the pending guidance is re-injected");
    const body = (await res.json()) as { started: boolean };
    assert.equal(body.started, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ui /api/health answers 200 without a token and leaks nothing about runs", async () => {
  // A health probe must work for an external monitor (reverse proxy, systemd
  // watchdog) that cannot present a token — but it sits behind the rate
  // limiter and carries nothing about any run, so answering before the auth
  // gate leaks nothing. A non-GET is not a probe and falls through to auth.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-ui-health-"));
  try {
    fs.writeFileSync(
      path.join(root, "ai-flow.config.json"),
      JSON.stringify({ runner: { command: ["fake-agent", "{promptFile}"] }, ui: { token: "s3cret-token" } }),
    );
    // A run record exists on disk: the probe's payload must not reflect it.
    const runDir = path.join(root, ".ai-flow", "runs", "5");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "state.json"),
      JSON.stringify({
        id: "5",
        formatVersion: 1,
        rev: 1,
        status: "failed",
        stage: "phase2",
        startedAt: "2026-09-28T00:00:00.000Z",
        updatedAt: "2026-09-28T00:00:00.000Z",
        baseCommit: "abc",
        worktree: root,
        stages: {},
        artifacts: {},
        taskdev: { mode: "standard", workspace: root, gates: {} },
        error: "boom",
      }),
    );
    const server = await startUi(root, "127.0.0.1", 0, { startRun: () => undefined });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(health.status, 200, "the probe answers without a token");
      assert.deepEqual(await health.json(), { ok: true }, "the payload carries no run data");
      // Not a probe: a POST falls through to the auth gate like any other route.
      const post = await fetch(`http://127.0.0.1:${port}/api/health`, { method: "POST" });
      assert.equal(post.status, 401);
      const runs = await fetch(`http://127.0.0.1:${port}/api/runs`);
      assert.equal(runs.status, 401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


