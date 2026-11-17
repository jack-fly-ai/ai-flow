import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACK_CAPABILITIES,
  parseAssignments,
  parseCapabilityTable,
  parseFixCommitFromLog,
  parseProgress,
  parseReplayInit,
  parseWorkspaceEnsure,
} from "../src/taskdev/taskdev.js";

test("parseAssignments: KEY=VALUE lines, ignores non-matching and trims", () => {
  const out = parseAssignments("WORKSPACE=/p\nMODE=replay\n  JUNK line\nBRANCH=main\n");
  assert.deepEqual(out, { WORKSPACE: "/p", MODE: "replay", BRANCH: "main" });
});

test("parseWorkspaceEnsure: extracts mode/workspace/branch; missing WORKSPACE throws", () => {
  assert.deepEqual(parseWorkspaceEnsure("WORKSPACE=/w\nMODE=replay\nBRANCH=b1"), {
    mode: "replay",
    workspace: "/w",
    branch: "b1",
  });
  assert.deepEqual(parseWorkspaceEnsure("WORKSPACE=/w\nMODE=standard"), {
    mode: "standard",
    workspace: "/w",
    branch: undefined,
  });
  assert.throws(() => parseWorkspaceEnsure("MODE=replay"), (e) => e instanceof Error && /no WORKSPACE/.test(e.message));
});

test("parseReplayInit: requires the four anchors; missing one throws", () => {
  const ok = parseReplayInit("REPLAY_DIR=/r\nTASK_DEV_DIR=/t\nBASELINE_COMMIT=aaa\nFIX_COMMIT=bbb\nCOPIED=1");
  assert.deepEqual(ok, {
    replayDir: "/r",
    taskDevDir: "/t",
    baselineCommit: "aaa",
    fixCommit: "bbb",
    copied: "1",
  });
  assert.throws(
    () => parseReplayInit("REPLAY_DIR=/r\nTASK_DEV_DIR=/t\nBASELINE_COMMIT=aaa"),
    (e) => e instanceof Error && /printed no/.test(e.message),
  );
});

test("parseProgress: parses phase/gates/notes and defaults", () => {
  const text = [
    "phase: 2",
    "gate1: passed",
    "gate2: rejected",
    "gate3: weird",
    "gate4: passed",
    "rounds: 3",
    "mode: orchestrated",
    "track: manual",
    "base: abc123",
    "slice: -",
    "awaiting: need-info",
    "- note one",
    "- note two",
  ].join("\n");
  const p = parseProgress(text);
  assert.equal(p.phase, 2);
  assert.deepEqual(p.gates, { 1: "passed", 2: "rejected", 3: "pending", 4: "passed" });
  assert.equal(p.rounds, 3);
  assert.equal(p.mode, "orchestrated");
  assert.equal(p.track, "manual");
  assert.equal(p.base, "abc123");
  assert.equal(p.slice, undefined);
  assert.equal(p.awaiting, "need-info");
  assert.deepEqual(p.notes, ["note one", "note two"]);
});

test("parseProgress: aborted phase and numeric coercion", () => {
  const p = parseProgress("phase: aborted\nrounds: 0");
  assert.equal(p.phase, "aborted");
  assert.equal(p.rounds, 0);
});

test("parseCapabilityTable: maps rows and sets autoTrack when all present", () => {
  const rows = PACK_CAPABILITIES.map((c) => `| ${c} | Phase 2 | ${c}.sh |`).join("\n");
  const table = `| capability | phase | command |\n| --- | --- | --- |\n${rows}`;
  const caps = parseCapabilityTable(table, "mymod");
  assert.equal(caps.module, "mymod");
  assert.equal(caps.autoTrack, true);
  assert.equal(caps.files.check, "check.sh");
  assert.equal(caps.files.accept, "accept.sh");
});

test("parseCapabilityTable: a manual-track row drops that capability and clears autoTrack", () => {
  const table = [
    "| capability | phase | command |",
    "| --- | --- | --- |",
    "| check | Phase 2 | check.sh |",
    "| repro | Phase 2 | repro.sh |",
    "| routing | Phase 2 | routing.sh |",
    "| accept | Phase 2 | accept.sh |",
    "| build | Phase 2 | build.sh |",
    "| deliverables | Phase 2 | manual track |",
    "| review-checklist | Phase 2 | review.sh |",
  ].join("\n");
  const caps = parseCapabilityTable(table, "mymod");
  assert.equal(caps.files.deliverables, undefined);
  assert.equal(caps.autoTrack, false);
  assert.equal(caps.files.check, "check.sh");
});

test("parseFixCommitFromLog: returns the hash of a TASK commit touching product content", () => {
  const log = [
    "hash1\0TASK42: fix the bug",
    "src/a.js",
    "hash2\0TASK42: only harness change",
    ".task-dev/state",
    "hash3\0unrelated commit",
    "src/b.js",
  ].join("\n");
  assert.equal(parseFixCommitFromLog(log, "TASK42"), "hash1");
});

test("parseFixCommitFromLog: no matching TASK commit returns null", () => {
  const log = ["h\0something else", "README.md"].join("\n");
  assert.equal(parseFixCommitFromLog(log, "TASK42"), null);
});
