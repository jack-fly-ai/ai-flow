import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  LOCAL_IDENTITY,
  authEnabled,
  authSettings,
  canOperateRun,
  identityFromEnv,
  identityFromRequest,
  packageDirFor,
  registryDirFor,
  resolveToken,
} from "../src/auth/auth.js";
import { loadConfig } from "../src/core/config.js";
import { StageError } from "../src/core/errors.js";
import { acquireRunLock, isProcessAlive, lockFile } from "../src/state/lock.js";
import { runPipeline, type PipelineDeps, type TaskdevOps } from "../src/orchestrator.js";
import { resetRun } from "../src/state/reset.js";
import { createState, readStateOrNull, writeState } from "../src/state/store.js";
import { getAdapter } from "../src/adapters/index.js";
import type { AiFlowConfig } from "../src/core/types.js";
import { startUi } from "../src/viewer/server.js";
import { waitUntil, withEnv } from "./helpers/test-utils.js";

// Isolation edition (src/auth.ts): identity, tenant scoping, per-user runs

const TOKENS = { "tok-operator": "operator", "tok-alice": "alice" };

function authConfig(overrides: Partial<AiFlowConfig> = {}): AiFlowConfig {
  return {
    runner: { command: ["fake-agent", "{promptFile}"] },
    taskdev: { skillDir: "skills/task-dev" },
    auth: { tokens: { ...TOKENS }, operator: "operator" },
    ...overrides,
  };
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-tenancy-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-m", "init"], {
    cwd: dir,
    stdio: "pipe",
  });
  return dir;
}

/** A task-dev control plane whose workspaceEnsure records the pipeline env and stops the run. */
function stoppingTaskdev(seen: { registry: string; pkg: string }): TaskdevOps {
  return {
    workspaceEnsure: async () => {
      seen.registry = process.env.TASK_WORKSPACE_REGISTRY ?? "";
      seen.pkg = process.env.TASK_PACKAGE_DIR ?? "";
      throw new StageError("stop here (test)", "finished", 1);
    },
    findFixCommit: async () => null,
    replayInit: async () => {
      throw new StageError("unexpected replay init", "finished", 1);
    },
    progressInit: async () => undefined,
    progressShow: async () => ({ phase: 0, rounds: 0, mode: "file", track: "auto", gates: {}, awaiting: null, notes: [] }),
    progressSetPhase: async () => undefined,
    progressSetGate: async () => undefined,
    progressSetBase: async () => undefined,
    progressAwaiting: async () => undefined,
    progressNote: async () => undefined,
    replayVerify: async () => "ok",
    replayAudit: async () => "clean",
    replayDiff: async () => "",
    replayDiffNames: async () => [],
    replayPackage: async () => "/tmp/x.tar.gz",
    replayMeta: () => null,
    replaySetMeta: async () => undefined,
  } satisfies TaskdevOps;
}

function pipelineDeps(seen: { registry: string; pkg: string }): Partial<PipelineDeps> {
  return {
    runAgent: async () => ({ exitCode: 0, commandName: "fake-agent" }),
    taskdev: stoppingTaskdev(seen),
    adapter: getAdapter(undefined),
    createTarPackage: () => ({ tarPath: "/tmp/unused.tar.gz", paths: [] }),
  };
}

test("authSettings parses tokens, defaults the operator, and keeps the legacy ui.token", () => {
  const settings = authSettings(authConfig());
  assert.deepEqual(settings.tokens, TOKENS);
  assert.equal(settings.operator, "operator");
  assert.equal(settings.legacyToken, "");
  assert.equal(authEnabled(settings), true);

  // No auth block at all: single-tenant, exactly like before.
  const bare = authSettings({ runner: { command: ["x"] } });
  assert.deepEqual(bare.tokens, {});
  assert.equal(authEnabled(bare), false);

  // Explicit operator wins over the insertion-order default.
  assert.equal(authSettings(authConfig({ auth: { tokens: { a: "x", b: "y" }, operator: "y" } })).operator, "y");
  assert.equal(authSettings(authConfig({ auth: { tokens: { a: "x", b: "y" } } })).operator, "x");

  // The legacy ui.token alone still enables auth (as an operator credential).
  const legacy = authSettings({ runner: { command: ["x"] }, ui: { token: "s3cret" } });
  assert.equal(authEnabled(legacy), true);
  assert.equal(legacy.legacyToken, "s3cret");
});

test("resolveToken maps tokens to identities with roles and rejects the rest", () => {
  const settings = authSettings(authConfig());
  assert.deepEqual(resolveToken(settings, "tok-alice"), { tenant: "alice", role: "user" });
  assert.deepEqual(resolveToken(settings, "tok-operator"), { tenant: "operator", role: "operator" });
  assert.equal(resolveToken(settings, "tok-nope"), null);
  assert.equal(resolveToken(settings, ""), null);
  assert.equal(resolveToken(settings, null), null);
  // A prefix of a real token must not match (no partial-credit oracle).
  assert.equal(resolveToken(settings, "tok-ali"), null);

  // Legacy single token resolves to the implicit local operator tenant (there
  // are no auth.tokens, so the operator defaults to the local tenant).
  const legacy = authSettings({ runner: { command: ["x"] }, ui: { token: "s3cret" } });
  assert.deepEqual(resolveToken(legacy, "s3cret"), { tenant: "local", role: "operator" });
  assert.equal(resolveToken(legacy, "nope"), null);
});

test("identityFromRequest: implicit local operator when auth is off, null when unauthorized", () => {
  const off = authSettings({ runner: { command: ["x"] } });
  assert.deepEqual(identityFromRequest(off, null), LOCAL_IDENTITY);
  assert.deepEqual(identityFromRequest(off, "anything"), LOCAL_IDENTITY);

  const on = authSettings(authConfig());
  assert.deepEqual(identityFromRequest(on, "tok-alice"), { tenant: "alice", role: "user" });
  assert.equal(identityFromRequest(on, "tok-nope"), null);
  assert.equal(identityFromRequest(on, null), null);
});

test("identityFromEnv reads AI_FLOW_TOKEN", () => {
  const on = authSettings(authConfig());
  assert.deepEqual(identityFromEnv(on, { AI_FLOW_TOKEN: "tok-alice" } as NodeJS.ProcessEnv), { tenant: "alice", role: "user" });
  assert.equal(identityFromEnv(on, {} as NodeJS.ProcessEnv), null);
  assert.equal(identityFromEnv(on, { AI_FLOW_TOKEN: "bogus" } as NodeJS.ProcessEnv), null);
});

test("canOperateRun: operator sees every run, a user only its own", () => {
  const alice = { tenant: "alice", role: "user" } as const;
  const operator = { tenant: "operator", role: "operator" } as const;
  assert.equal(canOperateRun(alice, "alice"), true);
  assert.equal(canOperateRun(alice, "carol"), false);
  // A legacy record with no owner is operator-only.
  assert.equal(canOperateRun(alice, undefined), false);
  assert.equal(canOperateRun(operator, "carol"), true);
  assert.equal(canOperateRun(operator, undefined), true);
});

test("registry and package directories are tenant-scoped only when auth is on", async () => {
  const on = authSettings(authConfig());
  const off = authSettings({ runner: { command: ["x"] } });
  await withEnv({ TASK_WORKSPACE_REGISTRY: "/shared/registry", TASK_PACKAGE_DIR: "/shared/pkg" }, () => {
    // Auth off: the shared roots (env overrides honored) — unchanged behavior.
    assert.equal(registryDirFor(off, null), "/shared/registry");
    assert.equal(packageDirFor(off, null), "/shared/pkg");
    // Auth on: per-tenant subdirectories.
    assert.equal(registryDirFor(on, { tenant: "alice", role: "user" }), "/shared/registry/alice");
    assert.equal(packageDirFor(on, { tenant: "alice", role: "user" }), "/shared/pkg/alice");
  });
});

test("loadConfig rejects a malformed auth block at startup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-authcfg-"));
  try {
    const write = (auth: unknown): void => {
      fs.writeFileSync(
        path.join(root, "ai-flow.config.json"),
        JSON.stringify({ runner: { command: ["fake-agent", "{promptFile}"] }, auth }),
      );
    };
    write({ tokens: ["not-an-object"] });
    assert.throws(() => loadConfig(root), (err: unknown) => err instanceof StageError && /auth\.tokens must be an object/.test(err.message));
    write({ tokens: { tok: "" } });
    assert.throws(() => loadConfig(root), (err: unknown) => err instanceof StageError && /non-empty tenant id/.test(err.message));
    write({ tokens: { tok: "alice" }, operator: 42 });
    assert.throws(() => loadConfig(root), (err: unknown) => err instanceof StageError && /auth\.operator/.test(err.message));
    // A valid block loads and normalizes.
    write({ tokens: { tok: "alice" }, operator: "alice" });
    assert.deepEqual(authSettings(loadConfig(root)).tokens, { tok: "alice" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a run lock held by another user's live process is refused (uid guard), force takes over", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-lockuid-"));
  // The child is OUR uid; the lock's forged foreign uid is what the guard must
  // key on — exactly the shape a real cross-user lock has (a live pid whose
  // recorded uid belongs to another user must never be reaped as "stale").
  const child = spawn("bash", ["-c", "sleep 30; :"], { stdio: "ignore" });
  try {
    // The uid guard keys on the child EXISTING (processExists distinguishes
    // ESRCH from EPERM); condition-wait for liveness instead of a blind sleep.
    await waitUntil(() => isProcessAlive(child.pid!), { message: "the fixture child never became a live process" });
    assert.ok(child.pid, "fixture child must be live");
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: child.pid, uid: 999999, startedAt: new Date().toISOString() }));
    await assert.rejects(
      acquireRunLock(dir),
      (err: unknown) => err instanceof StageError && /another user/.test(err.message) && /999999/.test(err.message),
    );
    // The refused lock stays put — nothing was reaped.
    assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).pid, child.pid);
    // --force (the operator's explicit call) takes it over.
    const forced = await acquireRunLock(dir, { force: true });
    assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).pid, process.pid);
    forced.release();
  } finally {
    if (child.pid) process.kill(child.pid, "SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runPipeline stamps the owner, scopes registry/package env for the run, and restores it", async () => {
  const root = initRepo();
  const skillToolsDir = path.join(root, "skills", "task-dev", "tools");
  fs.mkdirSync(skillToolsDir, { recursive: true });
  for (const t of ["task-workspace", "task-progress", "task-replay"]) {
    const p = path.join(skillToolsDir, t);
    fs.writeFileSync(p, "#!/bin/sh\n");
    fs.chmodSync(p, 0o755);
  }
  const seen = { registry: "", pkg: "" };
  try {
    await withEnv({ TASK_WORKSPACE_REGISTRY: path.join(root, "registry"), TASK_PACKAGE_DIR: path.join(root, "pkg") }, async () => {
      const result = await runPipeline({
        repoRoot: root,
        id: "77",
        log: () => undefined,
        config: authConfig({ taskdev: { skillDir: path.join(root, "skills", "task-dev") } }),
        tenant: "alice",
        deps: pipelineDeps(seen),
      });
      assert.equal(result.exitCode, 2, "the stopping workspaceEnsure fails the workspace stage");

      // The run record is owned by the tenant.
      const state = readStateOrNull(path.join(root, ".ai-flow", "runs", "77"));
      assert.equal(state?.owner, "alice");

      // Inside the run the shared roots were tenant-scoped...
      assert.equal(seen.registry, path.join(root, "registry", "alice"));
      assert.equal(seen.pkg, path.join(root, "pkg", "alice"));
      // ...and restored afterwards, so a long-lived process is not left scoped.
      assert.equal(process.env.TASK_WORKSPACE_REGISTRY, path.join(root, "registry"));
      assert.equal(process.env.TASK_PACKAGE_DIR, path.join(root, "pkg"));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runPipeline resolves the identity from AI_FLOW_TOKEN and refuses an unauthenticated run", async () => {
  const root = initRepo();
  const skillToolsDir = path.join(root, "skills", "task-dev", "tools");
  fs.mkdirSync(skillToolsDir, { recursive: true });
  for (const t of ["task-workspace", "task-progress", "task-replay"]) {
    const p = path.join(skillToolsDir, t);
    fs.writeFileSync(p, "#!/bin/sh\n");
    fs.chmodSync(p, 0o755);
  }
  const config = authConfig({ taskdev: { skillDir: path.join(root, "skills", "task-dev") } });
  try {
    await withEnv({ AI_FLOW_TOKEN: "tok-alice" }, async () => {
      const seen = { registry: "", pkg: "" };
      const result = await runPipeline({ repoRoot: root, id: "78", log: () => undefined, config, deps: pipelineDeps(seen) });
      assert.equal(result.exitCode, 2);
      assert.equal(readStateOrNull(path.join(root, ".ai-flow", "runs", "78"))?.owner, "alice");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // With auth configured and no token at all, the run never starts.
  await assert.rejects(
    () =>
      runPipeline({
        repoRoot: root,
        id: "79",
        log: () => undefined,
        config,
        deps: pipelineDeps({ registry: "", pkg: "" }),
      }),
    (err: unknown) => err instanceof StageError && err.kind === "startup" && /Authentication required/.test(err.message),
  );
});

test("runPipeline refuses to resume another tenant's run record", async () => {
  const root = initRepo();
  const skillToolsDir = path.join(root, "skills", "task-dev", "tools");
  fs.mkdirSync(skillToolsDir, { recursive: true });
  for (const t of ["task-workspace", "task-progress", "task-replay"]) {
    const p = path.join(skillToolsDir, t);
    fs.writeFileSync(p, "#!/bin/sh\n");
    fs.chmodSync(p, 0o755);
  }
  const config = authConfig({ taskdev: { skillDir: path.join(root, "skills", "task-dev") } });
  try {
    const runDir = path.join(root, ".ai-flow", "runs", "80");
    fs.mkdirSync(runDir, { recursive: true });
    writeState(runDir, createState("80", root, "abc", "carol"));
    await assert.rejects(
      () =>
        runPipeline({
          repoRoot: root,
          id: "80",
          log: () => undefined,
          config,
          tenant: "alice",
          deps: pipelineDeps({ registry: "", pkg: "" }),
        }),
      (err: unknown) => err instanceof StageError && /owned by tenant "carol"/.test(err.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* The viewer's Retry / Reject / escalation-answer actions spawn the pipeline
 * with the CALLER's token, so the operator — the one identity allowed to act on
 * every run — must be able to resume another tenant's record; refusing it here
 * would make those actions dead buttons. The scoping follows the RECORD's owner
 * so the resumed run still reads and writes the OWNER's registry/package roots. */
test("runPipeline: the operator resumes another tenant's run, scoped to the record's owner", async () => {
  const root = initRepo();
  const skillToolsDir = path.join(root, "skills", "task-dev", "tools");
  fs.mkdirSync(skillToolsDir, { recursive: true });
  for (const t of ["task-workspace", "task-progress", "task-replay"]) {
    const p = path.join(skillToolsDir, t);
    fs.writeFileSync(p, "#!/bin/sh\n");
    fs.chmodSync(p, 0o755);
  }
  const seen = { registry: "", pkg: "" };
  try {
    await withEnv({ TASK_WORKSPACE_REGISTRY: path.join(root, "registry"), TASK_PACKAGE_DIR: path.join(root, "pkg") }, async () => {
      // A failed, carol-owned record waiting to be resumed from the workspace stage.
      const runDir = path.join(root, ".ai-flow", "runs", "81");
      fs.mkdirSync(runDir, { recursive: true });
      const prior = createState("81", root, "abc", "carol");
      prior.status = "failed";
      prior.stage = "workspace";
      writeState(runDir, prior);

      const result = await runPipeline({
        repoRoot: root,
        id: "81",
        log: () => undefined,
        config: authConfig({ taskdev: { skillDir: path.join(root, "skills", "task-dev") } }),
        tenant: "operator",
        deps: pipelineDeps(seen),
      });
      // The workspace stage ran and failed on the stopping fake (exitCode 2) —
      // the run was NOT refused at the ownership backstop (that is exitCode 1).
      assert.equal(result.exitCode, 2);

      // The record keeps its original owner (an operator action does not steal it)...
      assert.equal(readStateOrNull(runDir)?.owner, "carol");

      // ...and the shared roots were scoped to the OWNER, not the acting operator.
      assert.equal(seen.registry, path.join(root, "registry", "carol"));
      assert.equal(seen.pkg, path.join(root, "pkg", "carol"));
      // Restored afterwards, so a long-lived process is not left scoped.
      assert.equal(process.env.TASK_WORKSPACE_REGISTRY, path.join(root, "registry"));
      assert.equal(process.env.TASK_PACKAGE_DIR, path.join(root, "pkg"));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createState carries the owner; legacy records stay ownerless", () => {
  const owned = createState("1", "/wt", "abc", "alice");
  assert.equal(owned.owner, "alice");
  const legacy = createState("1", "/wt", "abc");
  assert.equal(legacy.owner, undefined);
});


/** A repo root with an auth config and two owned runs plus one legacy run. */
function viewerFixture(): { root: string; pkgRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-viewer-tenancy-"));
  fs.writeFileSync(
    path.join(root, "ai-flow.config.json"),
    JSON.stringify({ runner: { command: ["fake-agent", "{promptFile}"] }, auth: { tokens: { ...TOKENS }, operator: "operator" } }),
  );
  const pkgRoot = path.join(root, "pkg");
  const run = (id: string, owner?: string, packageFile?: string): void => {
    const runDir = path.join(root, ".ai-flow", "runs", id);
    fs.mkdirSync(runDir, { recursive: true });
    const state = createState(id, root, "abc", owner);
    state.status = "awaiting_review";
    state.stage = "review";
    state.stages.review = { status: "awaiting_review" };
    state.awaiting = { kind: "gate4" };
    if (packageFile) state.artifacts.package = packageFile;
    writeState(runDir, state);
  };
  run("7", "alice", path.join(pkgRoot, "alice", "7_202610161200.tar.gz"));
  run("8", "carol", path.join(pkgRoot, "carol", "8_202610161200.tar.gz"));
  run("9"); // legacy: no owner
  for (const file of [
    path.join(pkgRoot, "alice", "7_202610161200.tar.gz"),
    path.join(pkgRoot, "carol", "8_202610161200.tar.gz"),
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fake-tar");
  }
  return { root, pkgRoot };
}

async function withViewer(root: string, body: (port: number) => Promise<void>): Promise<void> {
  const server = await startUi(root, "127.0.0.1", 0, { startRun: () => undefined });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    await body(port);
  } finally {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const authHeader = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

test("viewer with auth: 401 without a token, session reports tenant and role", async () => {
  const { root } = viewerFixture();
  try {
    await withEnv({ TASK_PACKAGE_DIR: path.join(root, "pkg") }, () => withViewer(root, async (port) => {
      const none = await fetch(`http://127.0.0.1:${port}/api/runs`);
      assert.equal(none.status, 401);
      const wrong = await fetch(`http://127.0.0.1:${port}/api/runs`, { headers: authHeader("tok-nope") });
      assert.equal(wrong.status, 401);
      // A static page is protected too.
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 401);

      const alice = await (await fetch(`http://127.0.0.1:${port}/api/session`, { headers: authHeader("tok-alice") })).json();
      assert.deepEqual(alice, { authEnabled: true, tenant: "alice", role: "user" });
      const operator = await (await fetch(`http://127.0.0.1:${port}/api/session`, { headers: authHeader("tok-operator") })).json();
      assert.deepEqual(operator, { authEnabled: true, tenant: "operator", role: "operator" });
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("viewer with auth: a user sees and acts on its own runs only; the operator sees all", async () => {
  const { root } = viewerFixture();
  try {
    await withEnv({ TASK_PACKAGE_DIR: path.join(root, "pkg") }, () => withViewer(root, async (port) => {
      const list = async (token: string): Promise<string[]> => {
        const response = await fetch(`http://127.0.0.1:${port}/api/runs`, { headers: authHeader(token) });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { runs: Array<{ id: string; owner: string | null }> };
        return body.runs.map((run) => run.id).sort();
      };
      assert.deepEqual(await list("tok-alice"), ["7"]);
      assert.deepEqual(await list("tok-operator"), ["7", "8", "9"]);

      // Own run: visible. Another tenant's run and a legacy record: 404 (not 403).
      const own = await fetch(`http://127.0.0.1:${port}/api/runs/7`, { headers: authHeader("tok-alice") });
      assert.equal(own.status, 200);
      const foreign = await fetch(`http://127.0.0.1:${port}/api/runs/8`, { headers: authHeader("tok-alice") });
      assert.equal(foreign.status, 404);
      const legacy = await fetch(`http://127.0.0.1:${port}/api/runs/9`, { headers: authHeader("tok-alice") });
      assert.equal(legacy.status, 404);
      // The operator sees both.
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/runs/8`, { headers: authHeader("tok-operator") })).status, 200);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/runs/9`, { headers: authHeader("tok-operator") })).status, 200);

      // Actions on a foreign run are refused the same way.
      const approve = await fetch(`http://127.0.0.1:${port}/api/runs/8/review`, {
        method: "POST",
        headers: { ...authHeader("tok-alice"), "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });
      assert.equal(approve.status, 404);
      const logs = await fetch(`http://127.0.0.1:${port}/api/runs/8/full-log`, { headers: authHeader("tok-alice") });
      assert.equal(logs.status, 404);
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("viewer with auth: package downloads are bound to the caller's tenant directory", async () => {
  const { root } = viewerFixture();
  try {
    await withEnv({ TASK_PACKAGE_DIR: path.join(root, "pkg") }, () => withViewer(root, async (port) => {
      // Alice downloads her own delivery: it lives in her tenant directory.
      const own = await fetch(`http://127.0.0.1:${port}/api/runs/7/package`, { headers: authHeader("tok-alice") });
      assert.equal(own.status, 200);
      assert.match(own.headers.get("content-disposition") ?? "", /7_202610161200\.tar\.gz/);
      // Carol's run is not visible to her (ownership precedes the dir check).
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/runs/8/package`, { headers: authHeader("tok-alice") })).status, 404);
      // The operator sees the run, but the tarball in ANOTHER tenant's
      // directory is out of the operator's scope — the dir binding refuses it.
      const crossTenant = await fetch(`http://127.0.0.1:${port}/api/runs/8/package`, { headers: authHeader("tok-operator") });
      assert.equal(crossTenant.status, 404);
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("viewer with auth: Manage MCP is operator-only", async () => {
  const { root } = viewerFixture();
  try {
    await withViewer(root, async (port) => {
      const asUser = await fetch(`http://127.0.0.1:${port}/api/mcp`, { headers: authHeader("tok-alice") });
      assert.equal(asUser.status, 403);
      const body = (await asUser.json()) as { error: string };
      assert.match(body.error, /operator-only/);
      // The same route as an operator passes the role gate.
      const asOperator = await fetch(`http://127.0.0.1:${port}/api/mcp`, { headers: authHeader("tok-operator") });
      assert.equal(asOperator.status, 200);
      // And a mutation as a user is refused on the role, before any payload work.
      const upsert = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
        method: "POST",
        headers: { ...authHeader("tok-alice"), "content-type": "application/json" },
        body: JSON.stringify({ scope: "user", name: "x", spec: { type: "http", url: "https://x" } }),
      });
      assert.equal(upsert.status, 403);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("viewer without auth stays single-tenant (implicit operator, no filtering)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-viewer-open-"));
  try {
    fs.mkdirSync(path.join(root, ".ai-flow", "runs", "3"), { recursive: true });
    const state = createState("3", root, "abc"); // legacy, no owner
    state.status = "awaiting_review";
    state.awaiting = { kind: "gate4" };
    writeState(path.join(root, ".ai-flow", "runs", "3"), state);
    await withViewer(root, async (port) => {
      const listed = await fetch(`http://127.0.0.1:${port}/api/runs`);
      assert.equal(listed.status, 200);
      const body = (await listed.json()) as { runs: Array<{ id: string }> };
      assert.deepEqual(body.runs.map((run) => run.id), ["3"]);
      const detail = await fetch(`http://127.0.0.1:${port}/api/runs/3`);
      assert.equal(detail.status, 200);
      const session = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json();
      assert.deepEqual(session, { authEnabled: false, tenant: "local", role: "operator" });
      // Manage MCP stays available to the implicit operator.
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/mcp`)).status, 200);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resetRun honors the tenant-scoped registry option", async () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, "ai-flow.config.json"), JSON.stringify({ runner: { command: ["fake-agent", "{promptFile}"] } }));
  const registry = path.join(root, "registry", "alice");
  const workspace = path.join(root, "ws");
  try {
    fs.mkdirSync(registry, { recursive: true });
    fs.mkdirSync(path.join(workspace, ".task-dev", "81"), { recursive: true });
    fs.writeFileSync(path.join(registry, "81"), workspace);
    fs.writeFileSync(path.join(registry, "81.mode"), "standard");
    fs.mkdirSync(path.join(root, ".ai-flow", "runs", "81"), { recursive: true });
    await resetRun({ repoRoot: root, id: "81", registry, log: () => undefined });
    assert.equal(fs.existsSync(path.join(registry, "81")), false, "the registry entry is removed");
    assert.equal(fs.existsSync(path.join(registry, "81.mode")), false);
    assert.equal(fs.existsSync(workspace), false, "the tenant's workspace clone is removed");
    assert.equal(fs.existsSync(path.join(root, ".ai-flow", "runs", "81")), false, "the run record is removed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
