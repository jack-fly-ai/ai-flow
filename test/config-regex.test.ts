import assert from "node:assert/strict";
import { test } from "node:test";
import { agentProcessPatterns, cliRunPattern } from "../src/core/config.js";
import type { AiFlowConfig } from "../src/core/types.js";

/* The ticket id is interpolated into a POSIX ERE consumed by `pkill -f`. An
 * unescaped metacharacter would turn the anchored pattern into a wildcard and
 * let `ai-flow stop` kill the wrong run. normalizeId keeps ids numeric, but
 * callers (and the existing tests) pass raw ids, so the interpolation must be
 * escaped — matching the literal-command-part escaping already done at the join
 * in agentProcessPatterns. */

function cfg(command: string[]): AiFlowConfig {
  return { runner: { command } } as AiFlowConfig;
}

test("cliRunPattern escapes regex metacharacters in the id", () => {
  assert.equal(cliRunPattern("123"), "(cli\\.(js|ts)|ai-flow(\\.exe)?) run 123([^0-9]|$)");
  // A dot or plus must be escaped so pkill -f cannot turn it into a wildcard.
  assert.equal(cliRunPattern("1.2"), "(cli\\.(js|ts)|ai-flow(\\.exe)?) run 1\\.2([^0-9]|$)");
  assert.equal(cliRunPattern("1+2"), "(cli\\.(js|ts)|ai-flow(\\.exe)?) run 1\\+2([^0-9]|$)");
});

test("agentProcessPatterns escapes the ticket digits in the workspace anchor", () => {
  const withCwd = cfg(["agent", "--workspace", "{cwd}", "--model", "{model}"]);
  assert.ok(agentProcessPatterns(withCwd, "TASK12345").some((p) => p.includes("[tT][aA][sS][kK]12345")));
  // A metachar id is escaped rather than injected into the ERE.
  assert.ok(agentProcessPatterns(withCwd, "TASK1.2").some((p) => p.includes("[tT][aA][sS][kK]1\\.2")));
});

/* The anchor must actually match a TASK123-style workspace path (the "task"
 * part, case-insensitively — POSIX ERE has no case-fold flag) and must not
 * match an unrelated path that merely ends in the same digits. */
test("agentProcessPatterns anchors on the task part of the workspace path", () => {
  const withCwd = cfg(["agent", "--workspace", "{cwd}", "--model", "{model}"]);
  const agentPattern = agentProcessPatterns(withCwd, "TASK123")[1]!;
  const re = new RegExp(agentPattern);
  assert.ok(re.test("agent --workspace /home/u/ws/TASK123 --model sonnet"), "a TASK123-style workspace path matches");
  assert.ok(re.test("agent --workspace /home/u/ws/task123 --model sonnet"), "the task part matches case-insensitively");
  assert.ok(!re.test("agent --workspace /home/u/ws/webapp-123 --model sonnet"), "an unrelated path ending in the same digits does not match");
});

test("agentProcessPatterns appends the trailing boundary only when {cwd} is last", () => {
  const trailing = cfg(["claude", "--prompt", "{promptArg}", "--cwd", "{cwd}"]);
  const patterns = agentProcessPatterns(trailing, "TASK99");
  const agentPattern = patterns[1];
  assert.ok(agentPattern.endsWith("([^0-9]|$)"), `expected trailing boundary, got ${agentPattern}`);

  const notTrailing = cfg(["agent", "--workspace", "{cwd}", "--model", "{model}"]);
  const patterns2 = agentProcessPatterns(notTrailing, "TASK99");
  assert.ok(!patterns2[1].endsWith("([^0-9]|$)"), `expected no trailing boundary, got ${patterns2[1]}`);
});
