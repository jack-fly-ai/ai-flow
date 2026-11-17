import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/* CLI dispatch (src/cli.ts) had no direct test: the suite imported the library
 * surface, or spawned fake `cli.js` processes only as kill targets. These tests
 * run the REAL entry point (through tsx, exactly as `npm run ai-flow` does) in
 * a throwaway git repo and pin the exit-code contract. The CLI resolves the
 * repo root through git, so each temp repo is initialized. */

const CLI = path.resolve(import.meta.dirname, "..", "src", "cli.ts");
/* `--import tsx` resolves the package from the CHILD's cwd (the throwaway
 * repo), where node_modules does not exist — resolve the loader's absolute
 * path from THIS package instead. */
const TSX_LOADER = createRequire(fileURLToPath(import.meta.url)).resolve("tsx");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, CLI, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** A throwaway git repo (the CLI resolves the repo root via `git rev-parse`). */
function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-cli-"));
  const git = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
  fs.mkdirSync(path.join(dir, ".ai-flow", "runs"), { recursive: true });
  return dir;
}

test("cli: no command and an unknown command print usage and exit 1", async () => {
  const dir = tempRepo();
  try {
    const bare = await runCli([], { cwd: dir });
    assert.equal(bare.code, 1, "a bare `ai-flow` is a usage mistake, not a success");
    assert.match(bare.stdout, /Usage:/);

    const bogus = await runCli(["frobnicate"], { cwd: dir });
    assert.equal(bogus.code, 1);
    assert.match(bogus.stdout, /Usage:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: run/stop/reset without a ticket id exit 1 with usage", async () => {
  const dir = tempRepo();
  try {
    for (const command of ["run", "stop", "reset"]) {
      const result = await runCli([command], { cwd: dir });
      assert.equal(result.code, 1, `${command} without an id must fail`);
      assert.match(result.stdout, /Usage:/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: run refuses a non-numeric ticket id", async () => {
  const dir = tempRepo();
  try {
    // A valid (legacy) config: `run` loads the config BEFORE normalizing the
    // id, so the config must exist for the id check to be the failure.
    fs.writeFileSync(path.join(dir, "ai-flow.config.json"), JSON.stringify({ runner: { command: ["fake-agent", "{promptFile}"] } }));
    const result = await runCli(["run", "not-a-ticket"], { cwd: dir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Task id must be a numeric GitHub issue number/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: status with no records exits 0; with a record it prints the stage line", async () => {
  const dir = tempRepo();
  try {
    const empty = await runCli(["status"], { cwd: dir });
    assert.equal(empty.code, 0);
    assert.match(empty.stdout, /No run records/);

    const runDir = path.join(dir, ".ai-flow", "runs", "42");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "state.json"),
      JSON.stringify({
        id: "42",
        status: "failed",
        stage: "phase2",
        startedAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        baseCommit: "abc",
        worktree: dir,
        stages: {},
        artifacts: {},
        taskdev: { mode: "standard", workspace: dir, gates: {} },
        error: null,
      }),
    );
    const listed = await runCli(["status"], { cwd: dir });
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /42\s+phase2\s+failed/);

    const single = await runCli(["status", "42"], { cwd: dir });
    assert.equal(single.code, 0);
    assert.match(single.stdout, /42\s+phase2\s+failed/);

    const missing = await runCli(["status", "77"], { cwd: dir });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No run record for 77/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: stop refuses when there is no run record", async () => {
  const dir = tempRepo();
  try {
    const result = await runCli(["stop", "55"], { cwd: dir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /No run record for 55/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: init rejects an unknown agent without writing a config", async () => {
  const dir = tempRepo();
  try {
    const result = await runCli(["init", "--agent", "nope", "--yes"], { cwd: dir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown agent "nope"/);
    assert.equal(fs.existsSync(path.join(dir, "ai-flow.config.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: init --agent cursor --yes writes the repo-root config", async () => {
  const dir = tempRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-cli-home-"));
  try {
    const result = await runCli(["init", "--agent", "cursor", "--model", "composer-2.5", "--yes"], {
      cwd: dir,
      // Hermetic HOME only: the CLI probes the repo root through `git`, so the
      // real PATH must stay (a stripped PATH breaks that probe, not the test).
      // The cursor `agent` binary is genuinely not installed on any CI host,
      // which is exactly the "not found but still writes" path under test.
      env: { HOME: home },
    });
    assert.equal(result.code, 0);
    const written = JSON.parse(fs.readFileSync(path.join(dir, "ai-flow.config.json"), "utf8")) as {
      agent: string;
      model: string;
      runner: { command: string[] };
    };
    assert.equal(written.agent, "cursor");
    assert.equal(written.model, "composer-2.5");
    assert.ok(written.runner.command.some((part) => part.includes("{promptStdin")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cli: run without a config file fails fast with the init hint", async () => {
  const dir = tempRepo();
  try {
    const result = await runCli(["run", "123"], { cwd: dir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Missing ai-flow\.config\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
