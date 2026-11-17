import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agentProcessPatterns } from "../src/core/config.js";
import { runInit } from "../src/agents/init.js";
import { runAgent } from "../src/agents/runner.js";
import { installRefTransactionLock, removeRefTransactionLock } from "../src/git/gitLock.js";
import { armRunWatchdog } from "../src/orchestrator.js";
import { parseCheckResult } from "../src/orchestrator/testStage.js";
import {
  ConcurrentStateError,
  createState,
  readState,
  StateConflictError,
  withStateUpdate,
  writeState,
} from "../src/state/store.js";
import { escapeHtml, renderFallbackMarkdown } from "../viewer-ui/src/markdown.ts";
import type { AiFlowConfig } from "../src/core/types.js";
import { waitUntil } from "./helpers/test-utils.js";

test("init writes the repo-root config and carries ui/taskdev over from the legacy file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-init-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-init-home-"));
  const legacy = path.join(root, "ai-flow", "ai-flow.config.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ ui: { host: "127.0.0.1", port: 4179 }, taskdev: { pack: "generic" } }));
  const lines: string[] = [];
  const result = await runInit({
    repoRoot: root,
    agent: "deepseek",
    model: "deepseek-v4",
    yes: true,
    installed: () => false,
    // Hermetic resolution: no PATH, empty HOME — dsh cannot be found on any host.
    env: { ...process.env, HOME: home, PATH: "" },
    log: (line) => lines.push(line),
  });
  assert.equal(result.wrote, true);
  assert.equal(result.file, path.join(root, "ai-flow.config.json"));
  const written = JSON.parse(fs.readFileSync(result.file, "utf8")) as { agent: string; model: string; ui: { port: number }; taskdev: { pack: string } };
  assert.equal(written.agent, "deepseek");
  assert.equal(written.model, "deepseek-v4");
  assert.equal(written.ui.port, 4179);
  assert.equal(written.taskdev.pack, "generic");
  assert.match(lines.join("\n"), /dsh --profile headless \{promptArg\}/);
  assert.match(lines.join("\n"), /not found on PATH/);
});

test("init preserves the auth/run/advanced blocks across a re-init (no silent security downgrade)", async () => {
  // DROP every top-level block it did not own — dropping auth.tokens quietly
  // turned an isolation-edition viewer into an open single-tenant one.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-init-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-init-home-"));
  const configFile = path.join(root, "ai-flow.config.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      agent: "deepseek",
      model: "deepseek-v3",
      auth: { tokens: { "tok-alice": "alice", "tok-bob": "bob" }, operator: "alice" },
      run: { maxMinutes: 90 },
      advanced: { strictUnscoped: true, startWaitMs: 1234 },
      runner: { command: ["dsh", "--profile", "headless", "{promptArg}"], versionCheck: "^1\\.2$" },
      taskdev: { pack: "viewers", repo: "acme/webapp" },
      ui: { host: "0.0.0.0", port: 7777, token: "s3cret" },
    }),
  );
  const result = await runInit({
    repoRoot: root,
    agent: "deepseek",
    model: "deepseek-v4",
    yes: true,
    installed: () => false,
    env: { ...process.env, HOME: home, PATH: "" },
    log: () => undefined,
  });
  assert.equal(result.wrote, true);
  const written = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
  // Unmanaged top-level blocks survive verbatim.
  assert.deepEqual(written.auth, { tokens: { "tok-alice": "alice", "tok-bob": "bob" }, operator: "alice" });
  assert.deepEqual(written.run, { maxMinutes: 90 });
  assert.deepEqual(written.advanced, { strictUnscoped: true, startWaitMs: 1234 });
  // Managed fields are refreshed as asked.
  assert.equal(written.agent, "deepseek");
  assert.equal(written.model, "deepseek-v4");
  assert.deepEqual(written.taskdev, { skillDir: "skills/task-dev", pack: "viewers", repo: "acme/webapp" });
  assert.equal((written.ui as { host: string }).host, "0.0.0.0");
  // The user's custom runner fields still round-trip.
  assert.equal((written.runner as { versionCheck: string }).versionCheck, "^1\\.2$");
});









test("init leaves the existing repo-root config when overwrite is declined", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-init-"));
  const file = path.join(root, "ai-flow.config.json");
  fs.writeFileSync(file, "{\"keep\":true}\n");
  const result = await runInit({
    repoRoot: root,
    agent: "claude",
    model: "sonnet",
    ask: async () => "n",
    installed: () => true,
    log: () => undefined,
  });
  assert.equal(result.wrote, false);
  assert.equal(fs.readFileSync(file, "utf8"), "{\"keep\":true}\n");
});

test("runner launches a CLI from ~/.local/bin when PATH does not include it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-home-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-runner-"));
  const bindir = path.join(home, ".local", "bin");
  fs.mkdirSync(bindir, { recursive: true });
  const output = path.join(dir, "out.txt");
  const script = path.join(bindir, "fakeagent");
  fs.writeFileSync(script, "#!/bin/sh\nprintf '%s' \"$1\" > \"$2\"\n");
  fs.chmodSync(script, 0o755);
  const prompt = path.join(dir, "prompt.md");
  fs.writeFileSync(prompt, "stage prompt");
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = "/usr/bin:/bin";
  try {
    const result = await runAgent({
      command: ["fakeagent", "{promptArg}", output],
      cwd: dir,
      promptFile: prompt,
      logFile: path.join(dir, "agent.log"),
      applyModel: false,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(output, "utf8"), "stage prompt");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("runner records the agent and model and passes the prompt as an argument", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-runner-"));
  const prompt = path.join(dir, "prompt.md");
  const output = path.join(dir, "out.txt");
  const logFile = path.join(dir, "agent.log");
  fs.writeFileSync(prompt, "stage prompt");
  const script = path.join(dir, "agent.mjs");
  fs.writeFileSync(script, "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], process.argv[3] ?? '');\n");
  const result = await runAgent({
    command: [process.execPath, script, output, "{promptArg}"],
    cwd: dir,
    promptFile: prompt,
    logFile,
    model: "composer-2.5",
    agentId: "cursor",
    applyModel: false,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(fs.readFileSync(output, "utf8"), "stage prompt");
  assert.match(fs.readFileSync(logFile, "utf8"), /^# agent=cursor model=composer-2\.5\n/);
});

test("runner redacts the on-disk stage log (console stays raw)", async () => {
  // must never contain credentials the agent echoed, even though the
  // operator console stream is intentionally left raw.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-runner-redact-"));
  const logFile = path.join(dir, "agent.log");
  const prompt = path.join(dir, "prompt.md");
  fs.writeFileSync(prompt, "p");
  const script = path.join(dir, "agent.mjs");
  fs.writeFileSync(script, "console.log(\"Authorization: Bearer supersecrettoken\"); console.log(\"password=hunter22\");\n");
  const result = await runAgent({
    command: [process.execPath, script],
    cwd: dir,
    promptFile: prompt,
    logFile,
    applyModel: false,
  });
  assert.equal(result.exitCode, 0);
  const onDisk = fs.readFileSync(logFile, "utf8");
  assert.equal(onDisk.includes("supersecrettoken"), false, "the on-disk log must be redacted");
  assert.equal(onDisk.includes("hunter22"), false, "the on-disk log must be redacted");
  assert.match(onDisk, /Authorization: <redacted>/);
  assert.match(onDisk, /password=<redacted>/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("stop patterns only anchor the agent pattern when the command has {cwd}", () => {
  const cfg = (command: string[]) => ({ runner: { command } });
  // deepseek preset: prompt-only command, no {cwd} → only the ticket-anchored
  // CLI pattern. An unanchored agent pattern would match every dsh headless
  // process on the machine (other tickets included).
  const deepseek = agentProcessPatterns(cfg(["dsh", "--profile", "headless", "{promptArg}"]), "TASK12345");
  // The pattern must stay valid POSIX ERE: pkill's regcomp rejects the PCRE
  // non-capturing (?:..) form (exit 2, kills nothing), so only capturing
  // groups are used. The anchor must match both the node-run CLI
  // (dist/cli.js run TASK..) and the installed `ai-flow` / `ai-flow.exe` bin.
  // The trailing boundary keeps prefix-related tickets apart (pkill -f is
  // an unanchored substring search: "run TASK12345" is a substring of
  // "run TASK123456").
  assert.deepEqual(deepseek, ["(cli\\.(js|ts)|ai-flow(\\.exe)?) run TASK12345([^0-9]|$)"]);
  assert.doesNotMatch(deepseek[0], /\(\?:/);
  // cursor preset: embeds {cwd} mid-command → the agent pattern is allowed,
  // anchored to task<digits> case-insensitively (workspace paths may carry
  // TASK<digits>). Another token follows {cwd}, so the joining \s+ already
  // delimits the ticket number — no explicit boundary needed.
  const cursor = agentProcessPatterns(cfg(["agent", "--workspace", "{cwd}", "--model", "{model}", "{promptStdin}"]), "TASK12345");
  assert.equal(cursor.length, 2);
  assert.match(cursor[1], /\[tT\]\[aA\]\[sS\]\[kK\]12345\\s\+/);
  assert.doesNotMatch(cursor[1], /12345\(\[\^0-9\]/);
  // {cwd} as the LAST token: the number runs to the end of the cmdline and
  // needs the explicit boundary (the $-anchor form is valid glibc ERE).
  const trailing = agentProcessPatterns(cfg(["claude", "--prompt", "{promptArg}", "--cwd", "{cwd}"]), "TASK12345");
  assert.equal(trailing.length, 2);
  assert.match(trailing[1], /\[tT\]\[aA\]\[sS\]\[kK\]12345\(\[\^0-9\]\|\$\)$/);
  // no command at all → CLI pattern only.
  assert.deepEqual(agentProcessPatterns(cfg([]), "TASK99"), ["(cli\\.(js|ts)|ai-flow(\\.exe)?) run TASK99([^0-9]|$)"]);
});

test("git ref lock blocks the agent from committing or checking out", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-reflock-"));
  const run = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  // reference-transaction arrived in Git 2.28; skip the behavioral assertions
  // on older git (the hook is simply never invoked there, and the after-the-fact
  // assertNoAgentOverreach check remains the backstop).
  const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim();
  const match = /(\d+)\.(\d+)/.exec(version);
  const supported = match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 28));
  try {
    run(["init", "-q"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "test"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    run(["add", "a.txt"]);
    run(["commit", "-q", "-m", "base"]);
    const headBefore = run(["rev-parse", "HEAD"]).stdout.trim();

    assert.equal(installRefTransactionLock(dir), true, "lock installs in a git repo");

    // A commit by the agent must be aborted by the reference-transaction hook.
    fs.writeFileSync(path.join(dir, "b.txt"), "b");
    run(["add", "b.txt"]);
    const blockedCommit = run(["commit", "-q", "-m", "agent change"]);
    if (!supported) {
      removeRefTransactionLock(dir);
      return;
    }
    assert.notEqual(blockedCommit.status, 0, "agent commit is aborted by the hook");
    assert.equal(run(["rev-parse", "HEAD"]).stdout.trim(), headBefore, "HEAD must not move when the agent commits");

    // With the lock removed, the pipeline's own writes proceed normally.
    removeRefTransactionLock(dir);
    const allowedCommit = run(["commit", "-q", "-m", "agent change allowed"]);
    assert.equal(allowedCommit.status, 0, "commit is allowed once the lock is removed");
    const headAfter = run(["rev-parse", "HEAD"]).stdout.trim();
    assert.notEqual(headAfter, headBefore, "HEAD moves after lock removal");

    // Re-locking also blocks a branch-creating checkout.
    assert.equal(installRefTransactionLock(dir), true);
    run(["checkout", "-q", "-b", "agent-branch"]);
    assert.notEqual(run(["rev-parse", "--verify", "agent-branch"]).status, 0, "agent checkout/branch is blocked");
    assert.equal(run(["rev-parse", "HEAD"]).stdout.trim(), headAfter, "HEAD unchanged after blocked checkout");
  } finally {
    removeRefTransactionLock(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCheckResult marks a totals-less report as unverified, not passed", () => {
  // Hand-authored prose with no PASS=/FAIL=/SKIP= tokens at all.
  const prose = parseCheckResult(null, "# Test report\n\nAll cases behaved as expected.\n");
  assert.equal(prose.verdict, "unverified");
  assert.deepEqual([prose.pass, prose.fail, prose.skip], [0, 0, 0]);
  // An explicit (even all-zero) totals line is still a real result.
  assert.equal(parseCheckResult(null, "PASS=0 FAIL=0 SKIP=0").verdict, "passed");
  assert.equal(parseCheckResult(null, "Totals: PASS=2 FAIL=0 SKIP=1").verdict, "passed_with_blocked");
  // A parsed JSON body without totals and without cases is not evidence of a run.
  assert.equal(parseCheckResult("{}", "").verdict, "unverified");
  assert.equal(parseCheckResult('{"totals":{"pass":1,"fail":0,"skip":0}}', "").verdict, "passed");
});

test("runner records the agent pid and removes it on exit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-pid-"));
  const prompt = path.join(dir, "prompt.md");
  const script = path.join(dir, "agent.mjs");
  fs.writeFileSync(prompt, "stage prompt");
  fs.writeFileSync(script, "setTimeout(() => {}, 1500);\n");
  const pidFile = path.join(dir, "agent.pid");
  const agent = runAgent({
    command: [process.execPath, script],
    cwd: dir,
    promptFile: prompt,
    logFile: path.join(dir, "agent.log"),
    pidFile,
  });
  // The pid file appears while the agent is alive...
  let sawPid = false;
  for (let i = 0; i < 100 && !sawPid; i += 1) {
    if (fs.existsSync(pidFile)) {
      sawPid = true;
      assert.match(fs.readFileSync(pidFile, "utf8"), /^\d+$/);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal(sawPid, true);
  await agent;
  // ...and is gone once the agent exits.
  assert.equal(fs.existsSync(pidFile), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fallback markdown escapes ticket HTML before rendering", () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  const html = renderFallbackMarkdown("# Title\n\n<script>alert(1)</script>\n\n- **bold** item");
  assert.ok(!html.includes("<script>"), "raw <script> must never reach the DOM");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<b>bold<\/b>/);
});

test("writeState bumps rev monotonically and refuses a stale write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-rev-"));
  try {
    writeState(dir, createState("TASK1", "/wt", "abc"));
    assert.equal(readState(dir).rev, 1);
    // A second writer that still holds the rev-0 snapshot...
    const stale = createState("TASK1", "/wt", "abc");
    assert.throws(() => writeState(dir, stale), (err: unknown) => err instanceof ConcurrentStateError);
    assert.equal(readState(dir).rev, 1, "the refused write applies nothing");
    // ...while a fresh view still writes fine.
    const fresh = readState(dir);
    fresh.error = "updated";
    writeState(dir, fresh);
    assert.equal(readState(dir).rev, 2);
    assert.equal(readState(dir).error, "updated");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withStateUpdate retries a concurrent write and keeps both updates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-rev-"));
  try {
    writeState(dir, createState("TASK1", "/wt", "abc"));
    let attempts = 0;
    await withStateUpdate(dir, (state) => {
      attempts += 1;
      if (attempts === 1) {
        // Emulate a one-shot concurrent writer: bump the on-disk rev past
        // this snapshot's rev, so the write at the end of attempt 1 is
        // refused and retried against a fresh snapshot.
        const concurrent = readState(dir);
        concurrent.error = "concurrent writer";
        writeState(dir, concurrent);
      }
      state.error = `our update (attempt ${attempts})`;
    });
    assert.equal(attempts, 2, "the first attempt is refused and retried");
    const final = readState(dir);
    assert.equal(final.error, "our update (attempt 2)");
    assert.equal(final.rev, 3, "both writers' updates are kept");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withStateUpdate rethrows StateConflictError without retrying", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-rev-"));
  let attempts = 0;
  try {
    const base = createState("TASK1", "/wt", "abc");
    writeState(dir, base);
    await assert.rejects(
      withStateUpdate(dir, () => {
        attempts += 1;
        throw new StateConflictError("no longer awaiting review");
      }),
      (err: unknown) => err instanceof StateConflictError,
    );
    assert.equal(attempts, 1, "a semantic conflict is not a retry");
    assert.equal(readState(dir).rev, 1, "the state is untouched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// G14: watchdog, overreach guard, stream cache, CSRF, rate limit

test("the run watchdog stops the recorded agent after maxMinutes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-watchdog-"));
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  try {
    // stopAgent verifies the recorded pid against /proc/<pid>/cmdline; wait
    // until the spawned child is visible there instead of a blind settle
    // sleep (the precondition the check actually needs).
    await waitUntil(
      () => {
        try {
          return fs.readFileSync(`/proc/${child.pid}/cmdline`, "utf8").split("\0").filter(Boolean).length > 0;
        } catch {
          return false;
        }
      },
      { message: "the spawned agent never appeared in /proc" },
    );
    fs.writeFileSync(path.join(dir, "agent.pid"), String(child.pid));
    const timers = t.mock.timers;
    timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      const disarm = armRunWatchdog(dir, { run: { maxMinutes: 1 } } as AiFlowConfig, () => undefined);
      timers.tick(60_000); // watchdog fires: stopAgent SIGTERMs the agent, then waits
      timers.tick(1_100); // the SIGTERM grace window inside stopAgent
      disarm();
    } finally {
      timers.reset();
    }
    // Real-time wait for the exit to be observed.
    for (let i = 0; i < 150 && !exited; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(exited, true, "the recorded agent must be killed by the watchdog");
  } finally {
    if (!exited) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the run watchdog is disabled by maxMinutes 0", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-watchdog0-"));
  try {
    const timers = t.mock.timers;
    timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      const disarm = armRunWatchdog(dir, { run: { maxMinutes: 0 } } as AiFlowConfig, () => undefined);
      timers.tick(24 * 60 * 60_000); // a whole day: nothing may be scheduled
      disarm();
    } finally {
      timers.reset();
    }
    assert.ok(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

