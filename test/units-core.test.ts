import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { expandArgv, parseModelLines, resolvePresetBin, resolvePresetCommand, type AgentPreset } from "../src/agents/agents.js";
import { emitConfigWarnings, loadConfig } from "../src/core/config.js";
import { findExecutable } from "../src/agents/init.js";
import { createStreamFormatter } from "../src/agents/streamFormat.js";
import { viewersAdapter, getAdapter } from "../src/adapters/index.js";
import { createLineRedactor, redact, RedactingLineTransform } from "../src/auth/redact.js";
import {
  archiveSupersededPackages,
  beijingTimestamp,
  changedPathsStandard,
  packageName,
} from "../src/delivery/package.js";
import {
  parseCapabilityTable,
  parseProgress,
  parseReplayInit,
  parseWorkspaceEnsure,
  replayHarnessEnv,
  replayInit,
} from "../src/taskdev/taskdev.js";
import { phase1Prompt, phase2Prompt, phase3Prompt, phase4Prompt, withReviewFeedback } from "../src/orchestrator/prompts.js";
import { normalizeId, pipelineEnvOverrides } from "../src/orchestrator.js";
import { acquireRunLock, isAiFlowPipeline, isProcessAlive } from "../src/state/lock.js";
import { parseCheckResult } from "../src/orchestrator/testStage.js";
import { STATE_FORMAT_VERSION, createState, listRuns } from "../src/state/store.js";
import { waitUntil } from "./helpers/test-utils.js";
import type { AiFlowConfig, Change } from "../src/core/types.js";

test("listRuns tolerates additive fields but skips a record from a newer state schema", () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-runs-"));
  try {
    const current = path.join(runsRoot, "1");
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, "state.json"), `${JSON.stringify(createState("1", "/wt", "abc"))}\n`);
    const newer = path.join(runsRoot, "2");
    fs.mkdirSync(newer, { recursive: true });
    fs.writeFileSync(
      path.join(newer, "state.json"),
      `${JSON.stringify({ ...createState("2", "/wt", "abc"), formatVersion: STATE_FORMAT_VERSION + 1 })}\n`,
    );
    const broken = path.join(runsRoot, "3");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, "state.json"), "{not json");
    assert.deepEqual(
      listRuns(runsRoot).map((state) => state.id),
      ["1"],
      "a newer-schema record and a corrupted one are both skipped, never served raw",
    );
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("normalizeId accepts only numeric issue numbers", () => {
  assert.equal(normalizeId("12345"), "12345");
  assert.equal(normalizeId(" 99 "), "99");
  assert.throws(() => normalizeId("TASK12345"));
  assert.throws(() => normalizeId("task12"));
  assert.throws(() => normalizeId("#12"));
  assert.throws(() => normalizeId("TC12"));
});

test("redact hides bug-tracker cookies", () => {
  const text = "Bugzilla_login=a@b.c; Bugzilla_logincookie=798147;";
  assert.equal(redact(text).includes("798147"), false);
  assert.match(redact(text), /redacted/);
});

test("redact hides a broad set of credentials", () => {
  const samples: Array<[string, string]> = [
    ["password=supersecret", "supersecret"],
    ["api_token=sk_live_abc123", "sk_live_abc123"],
    ["access_token=ghp_0123456789", "ghp_0123456789"],
    ["auth_token: sess_abcdef", "sess_abcdef"],
    ["Authorization: Bearer tokentokentoken", "tokentokentoken"],
    ["Cookie: session=abcdef0123456789", "abcdef0123456789"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----", "MIIabc"],
  ];
  for (const [text, secret] of samples) {
    const out = redact(text);
    assert.equal(out.includes(secret), false, `expected ${secret} to be redacted in: ${text}`);
    assert.match(out, /redacted/);
  }
  // Public keys are NOT secrets and must survive.
  assert.match(redact("ssh-rsa AAAAB3publickeycomment user@host"), /AAAAB3publickeycomment/);
  // Plain, non-secret words are not touched.
  assert.equal(redact("token: 12345 is a count"), "token: 12345 is a count");
});

test("createLineRedactor redacts per complete line across chunk boundaries", () => {
  const lines: string[] = [];
  const redactor = createLineRedactor((line) => lines.push(line));
  // A secret split across chunks must still be caught: redaction runs on the
  // COMPLETED line, not on each chunk.
  redactor.push("password=");
  redactor.push("topsecre");
  redactor.push("t123 done\nnext line\n");
  redactor.flush();
  assert.equal(lines.length, 2);
  assert.equal(lines[0].includes("topsecret123"), false, "the split secret must be redacted");
  assert.match(lines[0], /password=<redacted> done/);
  assert.equal(lines[1], "next line\n");
});

test("createLineRedactor keeps a mid-UTF8 chunk split intact", () => {
  const lines: string[] = [];
  const redactor = createLineRedactor((line) => lines.push(line));
  const full = "h\u00e9llo w\u00f6rld\n";
  const buf = Buffer.from(full, "utf8");
  // Split in the middle of the multi-byte \u00e9.
  redactor.push(buf.subarray(0, 2));
  redactor.push(buf.subarray(2));
  redactor.flush();
  assert.equal(lines.join(""), full, "a split multi-byte char must reassemble");
});

test("createLineRedactor flushes a trailing partial line exactly once", () => {
  const lines: string[] = [];
  const redactor = createLineRedactor((line) => lines.push(line));
  redactor.push("tail without newline");
  redactor.flush();
  assert.deepEqual(lines, ["tail without newline\n"]);
  redactor.flush();
  assert.equal(lines.length, 1, "a second flush must not re-emit");
});

test("createLineRedactor bounds memory on a newline-free stream", () => {
  const lines: string[] = [];
  const redactor = createLineRedactor((line) => lines.push(line), 16);
  redactor.push("x".repeat(40));
  assert.equal(lines.length, 1, "the cap must flush the pending buffer");
  assert.equal(lines[0], "x".repeat(40) + "\n");
});

test("createLineRedactor bounds memory inside an unterminated PEM block too", () => {
  // a block is "small and bounded by the END marker" — but the AGENT controls
  // its own output, and a runaway stream of BEGIN lines with no END grew the
  // buffer without bound. At the cap the block is emitted best-effort (the
  // same path as flush) and buffering restarts.
  const lines: string[] = [];
  const redactor = createLineRedactor((line) => lines.push(line), 16);
  redactor.push("-----BEGIN X PRIVATE KEY-----\n");
  redactor.push("y".repeat(64));
  assert.equal(lines.length, 1, "the cap must flush even inside a PEM block");
  assert.ok(lines[0].includes("-----BEGIN X PRIVATE KEY-----"), "the flushed block is still emitted");
  // Buffering restarts: the redactor keeps working on later content.
  redactor.push("password=hunter2\n");
  redactor.flush();
  assert.match(lines[1], /password=<redacted>/);
});

test("RedactingLineTransform redacts a piped stream", async () => {
  const transform = new RedactingLineTransform();
  const out: string[] = [];
  transform.on("data", (chunk: Buffer) => out.push(chunk.toString("utf8")));
  const done = new Promise<void>((resolve, reject) => {
    transform.on("end", () => resolve());
    transform.on("error", reject);
  });
  transform.write("line one password=abc123\nplain\n");
  transform.write("partial");
  transform.end();
  await done;
  assert.equal(out.join(""), "line one password=<redacted>\nplain\npartial\n");
});

test("run lock serializes a single ticket and reaps stale locks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-lock-"));
  try {
    // Fresh acquisition writes the lock and release removes it.
    const a = await acquireRunLock(dir);
    assert.equal(fs.existsSync(path.join(dir, "run.lock")), true);
    a.release();
    assert.equal(fs.existsSync(path.join(dir, "run.lock")), false);

    // A stale lock (dead pid) is reaped and a new lock is taken.
    fs.writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ pid: 9_999_999, startedAt: "x" }));
    const b = await acquireRunLock(dir);
    const lock = JSON.parse(fs.readFileSync(path.join(dir, "run.lock"), "utf8"));
    assert.equal(typeof lock.pid, "number");
    assert.notEqual(lock.pid, 9_999_999);
    b.release();

    // An orphan agent left behind by a crashed run is reaped (here the pid is
    // dead, so it is simply ignored without error).
    fs.writeFileSync(path.join(dir, "agent.pid"), "9_999_999");
    const c = await acquireRunLock(dir);
    c.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lock release only removes the lock of its own pid", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-lock-"));
  try {
    const handle = await acquireRunLock(dir);
    // Simulate a force takeover: the lock now records a different pid.
    fs.writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ pid: 424242, startedAt: new Date().toISOString() }));
    handle.release();
    assert.equal(fs.existsSync(path.join(dir, "run.lock")), true, "a foreign lock must survive release");
    fs.rmSync(path.join(dir, "run.lock"), { force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a live pipeline lock is refused without force and taken over with it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-lock-"));
  // A process whose cmdline reads like an ai-flow pipeline: the marker
  // tokens must survive in /proc/<pid>/cmdline. bash -c exec-optimizes a
  // single simple command (the process replaces itself and the argv
  // degrades to ["sleep","30"], losing the markers), so the script is a
  // two-command list — bash then stays resident with the tokens in argv.
  const pipeline = spawn("bash", ["-c", "sleep 30; :", "ai-flow", "cli.js", "run"], { stdio: "ignore" });
  const foreign = spawn("bash", ["-c", "sleep 30; :"], { stdio: "ignore" });
  const cmdline = (pid?: number): string[] => {
    if (pid === undefined) return [];
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      return [];
    }
  };
  try {
    // Fixture precondition (condition-wait, not a blind sleep): the pipeline
    // must look live and recognizable — a bash behavior change must fail
    // here with evidence, not as a confusing "missing expected rejection".
    await waitUntil(
      () => {
        const argv = cmdline(pipeline.pid);
        return isProcessAlive(pipeline.pid!) && argv.includes("ai-flow") && argv.includes("run");
      },
      { message: "the pipeline fixture never became a live, recognizable ai-flow process" },
    );
    const argv = cmdline(pipeline.pid);
    assert.ok(argv.includes("ai-flow") && argv.includes("run"), `pipeline fixture lost its marker argv: ${JSON.stringify(argv)}`);
    assert.equal(isProcessAlive(pipeline.pid!), true, "pipeline fixture died before the assertions");
    // Live, recognizable pipeline lock: a plain acquire must refuse...
    fs.writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ pid: pipeline.pid, startedAt: new Date().toISOString() }));
    await assert.rejects(acquireRunLock(dir), (err: unknown) => err instanceof Error && /already in progress/.test(err.message));
    // ...but --force takes it over.
    const forced = await acquireRunLock(dir, { force: true });
    const lock = JSON.parse(fs.readFileSync(path.join(dir, "run.lock"), "utf8")) as { pid: number };
    assert.equal(lock.pid, process.pid);
    forced.release();
    // Live but NOT recognizable (a foreign process holding the lock number):
    // taken over without force, documented as a stale/foreign pid.
    assert.equal(isAiFlowPipeline(foreign.pid!), false, "foreign fixture must not read like an ai-flow pipeline");
    fs.writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ pid: foreign.pid, startedAt: new Date().toISOString() }));
    const taken = await acquireRunLock(dir);
    taken.release();
  } finally {
    for (const child of [pipeline, foreign]) {
      if (child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a live but unverifiable lock is refused without force (probe seam)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-lock-"));
  // The probe is injected (a test seam on acquireRunLock) so the VERDICT
  // handling is covered without actually making a live pid's cmdline
  // unreadable; the real /proc read is exercised by the fixture test above.
  try {
    // Alive + cmdline UNREADABLE ("unknown"): refuse, and the lock survives.
    fs.writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await assert.rejects(
      acquireRunLock(dir, { probe: () => "unknown" }),
      (err: unknown) => err instanceof Error && /could not be verified/.test(err.message),
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "run.lock"), "utf8")).pid, process.pid, "a refused lock must stay put");
    // --force takes an unverifiable lock over.
    const forced = await acquireRunLock(dir, { probe: () => "unknown", force: true });
    forced.release();
    // A VERIFIED-foreign live pid is taken over without force.
    fs.writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const taken = await acquireRunLock(dir, { probe: () => "no" });
    taken.release();
    // A VERIFIED ai-flow pid refuses through the same verdict path.
    fs.writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await assert.rejects(acquireRunLock(dir, { probe: () => "yes" }), (err: unknown) => err instanceof Error && /already in progress/.test(err.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace ensure output parses mode and workspace", () => {
  const parsed = parseWorkspaceEnsure("MODE=replay\nBRANCH=task/12345\nWORKSPACE=/home/demo/project\n");
  assert.deepEqual(parsed, { mode: "replay", workspace: "/home/demo/project", branch: "task/12345" });
  assert.equal(parseWorkspaceEnsure("WORKSPACE=/repo\n").mode, "standard");
  assert.throws(() => parseWorkspaceEnsure("no output"));
});

test("replay init output parses all keys", () => {
  const parsed = parseReplayInit(
    "REPLAY_DIR=/r/project\nTASK_DEV_DIR=/r/project/.task-dev\nBASELINE_COMMIT=aaa\nFIX_COMMIT=bbb\nCOPIED=skills/\n",
  );
  assert.equal(parsed.replayDir, "/r/project");
  assert.equal(parsed.baselineCommit, "aaa");
  assert.equal(parsed.fixCommit, "bbb");
  assert.equal(parsed.copied, "skills/");
  assert.throws(() => parseReplayInit("REPLAY_DIR=/r\n"));
});

test("progress markdown parses phase, gates, awaiting, and notes", () => {
  const snapshot = parseProgress(
    [
      "state root: /w/.task-dev",
      "# Progress: TASK1",
      "phase: 2",
      "mode: file",
      "track: auto",
      "slice: -",
      "rounds: 1",
      "gate1: passed",
      "gate2: pending",
      "gate3: pending",
      "gate4: pending",
      "awaiting: E1",
      "constraints:",
      "notes:",
      "- module pack: viewers",
      "- escalation open: E1 (blocks the current phase; resume re-presents it)",
    ].join("\n"),
  );
  assert.equal(snapshot.phase, 2);
  assert.equal(snapshot.rounds, 1);
  assert.equal(snapshot.gates[1], "passed");
  assert.equal(snapshot.gates[2], "pending");
  assert.equal(snapshot.awaiting, "E1");
  assert.equal(snapshot.notes.length, 2);
  const aborted = parseProgress("phase: aborted\nawaiting:\n");
  assert.equal(aborted.phase, "aborted");
  assert.equal(aborted.awaiting, null);
});

test("capability table parses the seven pack rows and detects manual track", () => {
  const readme = [
    "| Capability | Phase | File(s) |",
    "|---|---|---|",
    "| check | Phase 2 | tools/check.sh |",
    "| repro | Phase 1 | repro.md |",
    "| routing | Phase 1 | routing.md |",
    "| accept | Phase 3 | manual track |",
    "| build | Phase 2 | — |",
    "| deliverables | Phase 4 | gen_docs.py |",
    "| review-checklist | Phase 2.5 | automation.md |",
  ].join("\n");
  const parsed = parseCapabilityTable(readme, "viewers");
  assert.equal(parsed.files.check, "tools/check.sh");
  assert.equal(parsed.files.accept, undefined);
  assert.equal(parsed.autoTrack, false);

  const complete = parseCapabilityTable(
    readme.replace("| accept | Phase 3 | manual track |", "| accept | Phase 3 | runner.py |").replace("| build | Phase 2 | — |", "| build | Phase 2 | Makefile |"),
    "viewers",
  );
  assert.equal(complete.autoTrack, true);
});

test("viewers adapter scope guards keep changes inside the viewers surface", () => {
  // Out of scope: a repo-root doc is rejected.
  assert.throws(() => viewersAdapter.assertPhase2Scope([{ status: "A", path: "README.md" }] as Change[]));
  // In scope: an extensions/* file is allowed.
  assert.doesNotThrow(() => viewersAdapter.assertPhase2Scope([{ status: "M", path: "extensions/foo/Bar.js" }] as Change[]));
  // Mixed: one in-scope change alongside an out-of-scope change is rejected.
  assert.throws(() => viewersAdapter.assertPhase2Scope([{ status: "M", path: "platform/foo/Bar.ts" }, { status: "M", path: "docs/x.md" }] as Change[]));
  assert.throws(() => viewersAdapter.assertPhase2Scope([] as Change[]));
  assert.throws(() => viewersAdapter.assertPhase3Scope("same", "changed"));
  assert.doesNotThrow(() => viewersAdapter.assertPhase3Scope("same", "same"));
});

test("getAdapter dispatches viewers and falls back to generic", () => {
  assert.equal(getAdapter("viewers").module, "viewers");
  assert.equal(getAdapter("VIEWERS").module, "viewers");
  assert.equal(getAdapter(undefined).module, "generic");
  assert.equal(getAdapter("billing").module, "generic");
});

test("phase prompts carry the hard rules and workflow path", () => {
  const p1 = phase1Prompt({ skillDir: "/skills/task-dev", ticketPath: "/run/ticket.md", workspace: "/w", mode: "standard", id: "TASK1", repo: "acme/webapp" });
  assert.match(p1, /workflows\/phase1-requirement\.md/);
  assert.match(p1, /Never git commit/);
  assert.match(p1, /repro: red\|n\/a\|manual/);
  assert.match(p1, /Fetch issue #TASK1/);
  assert.match(p1, /the repository acme\/webapp/);
  assert.match(p1, /https:\/\/github\.com\/acme\/webapp\/issues\/TASK1/);
  assert.equal(p1.includes("TASKTASK"), false);
  assert.match(p1, /Do not run task-workspace ensure/);
  assert.match(p1, /Do not open existing tar archives/);
  assert.equal(p1.includes("Do not run task-preflight"), false);
  const p1replay = phase1Prompt({
    skillDir: "/skills/task-dev",
    ticketPath: "/run/ticket.md",
    workspace: "/w",
    mode: "replay",
    id: "TASK1",
    repo: "acme/webapp",
    fixCommit: "fix",
    baselineCommit: "base",
  });
  assert.match(p1replay, /REPLAY MODE/);
  const p2 = phase2Prompt({ skillDir: "/skills/task-dev", workspace: "/w", pack: "viewers", mode: "standard", requirementPath: "/w/.task-dev/TASK1/phase1-requirement.md", repo: "acme/webapp" });
  assert.match(p2, /references\/viewers/);
  assert.match(p2, /Do not run task-preflight again/);
  assert.match(withReviewFeedback(p2, "fix scope"), /Human review comment/);
  const p3 = phase3Prompt({ skillDir: "/skills/task-dev", workspace: "/w", pack: "viewers", testPlanPath: "/w/phase3-test-plan.md", testReportPath: "/w/phase3-test-report.md", repo: "acme/webapp" });
  assert.match(p3, /Do not run task-preflight again/);
  // The gate-2 freeze warning: a silent product-code edit in phase 3 fails the phase.
  assert.match(p3, /FROZEN at the gate-2 review/);
  const p4 = phase4Prompt({ skillDir: "/skills/task-dev", workspace: "/w", pack: "viewers", deliverablesDir: "/w/deliverables", repo: "acme/webapp" });
  assert.match(p4, /Do not install again/);
  assert.match(p4, /task-replay verify/);
});

test("phase prompts degrade to a neutral ticket source when taskdev.repo is unset", () => {
  const p1 = phase1Prompt({ skillDir: "/skills/task-dev", ticketPath: "/run/ticket.md", workspace: "/w", mode: "standard", id: "TASK1", repo: "" });
  assert.match(p1, /the repository configured in taskdev\.repo/);
  assert.equal(p1.includes("acme/webapp"), false);
  assert.equal(/github\.com/.test(p1), false);
});

test("replay init names the launching checkout as the skills harness", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-harness-"));
  const saved = process.env.TASK_REPLAY_HARNESS_SRC;
  try {
    delete process.env.TASK_REPLAY_HARNESS_SRC;
    assert.equal(replayHarnessEnv(root), undefined);

    const skillDir = path.join(root, "skills", "task-dev");
    fs.mkdirSync(path.join(skillDir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# skill\n");
    assert.deepEqual(replayHarnessEnv(root), { TASK_REPLAY_HARNESS_SRC: root });

    const seen = path.join(skillDir, "tools", "seen-harness");
    fs.writeFileSync(
      path.join(skillDir, "tools", "task-replay"),
      `#!/bin/bash
printf '%s' "\${TASK_REPLAY_HARNESS_SRC-}" > ${JSON.stringify(seen)}
printf 'REPLAY_DIR=/replay\\nTASK_DEV_DIR=/replay/.task-dev\\nBASELINE_COMMIT=base\\nFIX_COMMIT=fix\\n'
`,
    );
    fs.chmodSync(path.join(skillDir, "tools", "task-replay"), 0o755);
    const parsed = await replayInit({ skillDir, id: "TASK1", fixCommit: "fix", repo: root });
    assert.equal(parsed.replayDir, "/replay");
    assert.equal(fs.readFileSync(seen, "utf8"), root);

    process.env.TASK_REPLAY_HARNESS_SRC = "/operator/checkout";
    assert.equal(replayHarnessEnv(root), undefined);
  } finally {
    if (saved === undefined) delete process.env.TASK_REPLAY_HARNESS_SRC;
    else process.env.TASK_REPLAY_HARNESS_SRC = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package names use the Beijing timestamp", () => {
  const utc = new Date("2026-09-28T08:05:00Z"); // 16:05 Beijing
  assert.equal(packageName("TASK12345", utc), "TASK12345_202609281605.tar.gz");
  assert.match(beijingTimestamp(utc), /^\d{12}$/);
});

test("archiveSupersededPackages moves older same-ticket tarballs to archive/, never deletes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-pkg-archive-"));
  try {
    const older = path.join(dir, "77_202601010000.tar.gz");
    const older2 = path.join(dir, "77_202601020000.tar.gz");
    const current = path.join(dir, "77_202601030000.tar.gz");
    const other = path.join(dir, "88_202601030000.tar.gz");
    for (const file of [older, older2, current, other]) fs.writeFileSync(file, "tar-bytes");
    const moved = archiveSupersededPackages({ id: "77", keep: current, destinationDir: dir });
    assert.equal(moved.length, 2, "both superseded tarballs moved");
    assert.equal(fs.existsSync(current), true, "the current delivery stays put");
    assert.equal(fs.existsSync(other), true, "another ticket's delivery is untouched");
    assert.equal(fs.existsSync(older), false, "the superseded file left the delivery root");
    assert.equal(fs.readFileSync(path.join(dir, "archive", "77_202601010000.tar.gz"), "utf8"), "tar-bytes", "archived, not deleted");
    assert.equal(fs.readFileSync(path.join(dir, "archive", "77_202601020000.tar.gz"), "utf8"), "tar-bytes");
    // Idempotent: a second call finds nothing left to archive.
    assert.equal(archiveSupersededPackages({ id: "77", keep: current, destinationDir: dir }).length, 0);
    // A missing delivery directory is a no-op, not an error.
    assert.equal(archiveSupersededPackages({ id: "77", keep: current, destinationDir: path.join(dir, "nope") }).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("changedPathsStandard keeps non-deleted changes and drops reports", () => {
  assert.throws(() => changedPathsStandard("/nonexistent", "head"));
});

test("check report maps SKIP to blocked and FAIL to failed", () => {
  const skipped = parseCheckResult(
    JSON.stringify({
      totals: { pass: 2, fail: 0, skip: 1 },
      cases: [{ id: "db-pat-bymrn-01", status: "SKIP(env): no cis escalation" }],
    }),
    "",
  );
  assert.equal(skipped.verdict, "passed_with_blocked");
  assert.equal(skipped.skipped.length, 1);

  const failed = parseCheckResult(null, "Totals: PASS=0 FAIL=1 SKIP=0");
  assert.equal(failed.verdict, "failed");
});

test("expandArgv fills or drops the model flag and feeds the prompt", () => {
  const empty = expandArgv(["agent", "--model", "{model}", "{promptStdin}"], {
    cwd: "/work",
    promptFile: "/tmp/p.md",
    prompt: "stage prompt",
    model: "",
  });
  assert.deepEqual(empty.argv, ["agent"]);
  assert.equal(empty.stdin, "stage prompt");

  const filled = expandArgv(["agent", "--workspace", "{cwd}", "--model", "{model}", "{promptStdin}"], {
    cwd: "/work",
    promptFile: "/tmp/p.md",
    prompt: "stage prompt",
    model: "composer-2.5",
  });
  assert.deepEqual(filled.argv, ["agent", "--workspace", "/work", "--model", "composer-2.5"]);

  const positional = expandArgv(["dsh", "--profile", "headless", "{promptArg}"], {
    cwd: "/work",
    promptFile: "/tmp/p.md",
    prompt: "do the work",
    model: "deepseek-v4",
    applyModel: false,
  });
  assert.deepEqual(positional.argv, ["dsh", "--profile", "headless", "do the work"]);
  assert.equal(positional.stdin, null);

  const legacy = expandArgv(["claude", "run", "{promptStdin}"], {
    cwd: "/work",
    promptFile: "/tmp/p.md",
    prompt: "hi",
    model: "provider/model",
  });
  assert.deepEqual(legacy.argv, ["claude", "run", "--model", "provider/model"]);
});

test("parseModelLines reads cursor and claude listings", () => {
  const ids = parseModelLines("Available models\n\nauto - Auto (current, default)\ncomposer-2.5 - Composer 2.5\nTip: use --model\nprovider/model\n");
  assert.deepEqual(ids, ["auto", "composer-2.5", "provider/model"]);
});

test("findExecutable searches PATH and does not use which", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-bin-"));
  const bin = path.join(dir, "agent");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(bin, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = dir;
  try {
    assert.equal(findExecutable("agent"), bin);
    assert.equal(findExecutable("not-a-real-cli-xyz"), null);
  } finally {
    process.env.PATH = previous;
  }
});

test("loadConfig expands an agent preset and still accepts a legacy command", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-config-"));
  const file = path.join(root, "ai-flow.config.json");
  fs.writeFileSync(file, JSON.stringify({ agent: "cursor", model: "composer-2.5", runner: { command: ["stale"] } }));
  const loaded = loadConfig(root);
  assert.equal(loaded.agent, "cursor");
  assert.equal(loaded.model, "composer-2.5");
  assert.equal(loaded.runner.command[0], "agent");
  assert.ok(loaded.runner.command.includes("{promptStdin}"));

  fs.writeFileSync(file, JSON.stringify({ runner: { command: ["fake-agent", "{promptFile}"] } }));
  const legacy = loadConfig(root);
  assert.deepEqual(legacy.runner.command, ["fake-agent", "{promptFile}"]);
  assert.equal(legacy.agent, undefined);

  // An explicit, prompt-token-bearing command alongside an agent is honored
  // (what the file shows is what runs); a stale command without a prompt
  // token falls back to the preset expansion.
  fs.writeFileSync(
    file,
    JSON.stringify({ agent: "deepseek", runner: { command: ["/opt/dsh", "--profile", "headless", "{promptArg}"] } }),
  );
  const explicit = loadConfig(root);
  assert.deepEqual(explicit.runner.command, ["/opt/dsh", "--profile", "headless", "{promptArg}"]);

  // Operator runner extras survive the agent expansion alongside an explicit
  // command.
  fs.writeFileSync(
    file,
    JSON.stringify({
      agent: "claude",
      runner: {
        command: ["/opt/claude", "--cwd", "{cwd}", "--prompt", "{promptArg}"],
        statusCommand: ["/opt/claude-status", "{dir}"],
        modelsCommand: ["/opt/claude-models"],
      },
    }),
  );
  const extras = loadConfig(root);
  assert.deepEqual(extras.runner.command, ["/opt/claude", "--cwd", "{cwd}", "--prompt", "{promptArg}"]);
  assert.deepEqual(extras.runner.statusCommand, ["/opt/claude-status", "{dir}"]);
  assert.deepEqual(extras.runner.modelsCommand, ["/opt/claude-models"]);
});

test("config load warns when {model} follows a non-flag token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-modelwarn-"));
  const file = path.join(root, "ai-flow.config.json");
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (line: string) => {
    warnings.push(String(line));
  };
  try {
    // A flag immediately before {model} is the safe shape: no warning.
    fs.writeFileSync(file, JSON.stringify({ runner: { command: ["fake-agent", "-m", "{model}", "{promptFile}"] } }));
    emitConfigWarnings(loadConfig(root));
    assert.equal(warnings.length, 0, "a flag-adjacent {model} is fine");

    // A bare word before {model} will be glued to the model name by most
    // agents: warn the operator at config load, but still run the command.
    fs.writeFileSync(file, JSON.stringify({ runner: { command: ["fake-agent", "model-is", "{model}", "{promptFile}"] } }));
    const loaded = loadConfig(root);
    assert.deepEqual(loaded.runner.command, ["fake-agent", "model-is", "{model}", "{promptFile}"]);
    emitConfigWarnings(loaded);
    assert.equal(warnings.length, 1, "exactly one warning");
    assert.match(warnings[0], /\{model\} right after "model-is"/);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePresetBin falls back to binCandidates and rewrites the command", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-bin-"));
  const bin = path.join(root, "fake-agent");
  fs.writeFileSync(bin, "#!/bin/sh\n");
  fs.chmodSync(bin, 0o755);
  const preset: AgentPreset = {
    id: "fake",
    label: "Fake",
    bin: "definitely-not-on-path-xyz",
    command: ["definitely-not-on-path-xyz", "--cwd", "{cwd}", "{promptArg}"],
    binCandidates: ["~/no/such/place/nonexistent", bin],
    modelInCommand: false,
  };
  assert.equal(resolvePresetBin(preset), bin);
  assert.deepEqual(resolvePresetCommand(preset), [bin, "--cwd", "{cwd}", "{promptArg}"]);

  // reports the familiar "not on PATH" startup error.
  assert.equal(resolvePresetBin({ ...preset, binCandidates: [] }), null);
  assert.deepEqual(resolvePresetCommand({ ...preset, binCandidates: [] }), [
    "definitely-not-on-path-xyz",
    "--cwd",
    "{cwd}",
    "{promptArg}",
  ]);
});

test("stream formatter turns stream-json into a readable process log", () => {
  const events = [
    { type: "turn.started", payload: { input: "Fix the bug and verify." } },
    { type: "session.updated", payload: { noise: true } },
    { type: "model.streaming", payload: { assistantMessageId: "m1", kind: "reasoning_start" } },
    { type: "model.streaming", payload: { assistantMessageId: "m1", kind: "reasoning_delta", delta: "Read the file first" } },
    { type: "model.streaming", payload: { assistantMessageId: "m1", kind: "reasoning_end" } },
    { type: "model.streaming", payload: { assistantMessageId: "m1", kind: "tool_call", toolCallId: "c1", toolName: "Bash", input: { command: "echo hi" } } },
    { type: "tool.updated", payload: { toolCallId: "c1", kind: "started", toolName: "Bash" } },
    { type: "tool.updated", payload: { toolCallId: "c1", kind: "result", result: { success: true, content: "hi", perf: { totalMs: 2595 } } } },
    { type: "model.streaming", payload: { assistantMessageId: "m2", kind: "text_start" } },
    { type: "model.streaming", payload: { assistantMessageId: "m2", kind: "text_delta", delta: "DONE" } },
    { type: "model.streaming", payload: { assistantMessageId: "m2", kind: "text_end" } },
    { type: "turn.completed", payload: { response: "DONE", usage: { totalTokens: 46917 } } },
  ];
  const formatter = createStreamFormatter();
  const out: string[] = [];
  for (const event of events) out.push(...formatter.push(JSON.stringify(event)));
  out.push(...formatter.finish());
  const text = out.join("\n");
  assert.match(text, /\[user\] Fix the bug and verify\./);
  assert.match(text, /── step 1 ──/);
  assert.match(text, /thinking: Read the file first/);
  assert.match(text, /tool: Bash echo hi → ok \(2\.6s\)/);
  assert.match(text, /assistant: DONE/);
  assert.match(text, /\[turn completed\] response: DONE · tokens: 46917/);
  // session.updated noise is dropped, deltas never leak as raw lines.
  assert.doesNotMatch(text, /session\.updated|reasoning_delta/);

  // A stream cut mid-message still flushes what accumulated, and unknown
  // payloads stay invisible instead of crashing the reader.
  const cut = createStreamFormatter();
  cut.push(JSON.stringify(events[2]));
  cut.push(JSON.stringify(events[3]));
  assert.match(cut.finish().join("\n"), /thinking: Read the file first/);
  assert.deepEqual(cut.push("not json at all"), ["not json at all"]);
});

/* pipelineEnvOverrides is the bridge from the centralized ai-flow.config.json
 * fields to the TASK_/AI_FLOW_ channels the adapters and the git wrapper read.
 * types.ts documents those config fields as the centralized form of the same
 * variables; without this translation they were silently inert. */

function baseConfig(patch: Record<string, unknown> = {}): AiFlowConfig {
  return { runner: { command: ["fake-agent", "{promptFile}"] }, ...patch } as AiFlowConfig;
}

test("pipelineEnvOverrides: advanced.* and taskdev.forbidPaths translate to the documented channels", () => {
  const config = baseConfig({
    advanced: { gitMaxBuffer: 10_000, viewersScope: "X", viewersTestArea: "Y", viewersCheck: "Z" },
    taskdev: { forbidPaths: [".github/", "infrastructure/"] },
  });
  const map = Object.fromEntries(pipelineEnvOverrides(config));
  assert.equal(map.AI_FLOW_GIT_MAX_BUFFER, "10000");
  assert.equal(map.TASK_VIEWERS_SCOPE, "X");
  assert.equal(map.TASK_VIEWERS_TEST_AREA, "Y");
  assert.equal(map.TASK_VIEWERS_CHECK, "Z");
  assert.equal(map.TASK_FORBID_PATHS, ".github/,infrastructure/");
});

test("pipelineEnvOverrides: unset fields emit nothing (leave the operator's direct export untouched)", () => {
  assert.deepEqual(pipelineEnvOverrides(baseConfig()), []);
  assert.deepEqual(pipelineEnvOverrides(baseConfig({ advanced: {} })), []);
});

