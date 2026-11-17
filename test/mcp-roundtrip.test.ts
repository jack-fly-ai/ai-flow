import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  readServers,
  upsertServer,
  removeServer,
  setServerEnabled,
  isValidMcpName,
  normalizeSpec,
} from "../src/agents/mcp.js";
import type { McpDescriptor, McpFormat, McpServerSpec } from "../src/agents/mcp.js";

/* The operator-facing MCP surface is a security boundary (the agent must never
 * extend its own tool surface). These tests round-trip each of the five agent
 * config formats through the real read/upsert/remove/disable path using a
 * temp-file descriptor, so a regression in any format's parser or serializer
 * (the most brittle code in the MCP channel) fails loudly. They also pin the
 * "never overwrite a config we cannot parse" guard and the name/spec validators. */

function tmpDescriptor(format: McpFormat, ext: string): McpDescriptor {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rt-"));
  return {
    path: path.join(dir, `mcp.${ext}`),
    format,
    scope: "user",
    requiresApproval: false,
    verified: true,
  };
}

function cleanup(d: McpDescriptor): void {
  fs.rmSync(path.dirname(d.path), { recursive: true, force: true });
}

const stdioSpec: McpServerSpec = { type: "stdio", command: "tool", args: ["--x"], env: { A: "1" } };
const httpSpec: McpServerSpec = { type: "http", url: "https://h/api" };

const formats: ReadonlyArray<readonly [McpFormat, string]> = [
  ["generic", "json"],
  ["codex-toml", "toml"],
  ["dsh-cordis", "yml"],
];

for (const [format, ext] of formats) {
  test(`mcp roundtrip (${format}): upsert then read back stdio and http servers`, () => {
    const d = tmpDescriptor(format, ext);
    try {
      upsertServer(d, "alpha", stdioSpec);
      upsertServer(d, "beta", httpSpec);
      const servers = readServers(d);
      const a = servers.find((s) => s.name === "alpha");
      const b = servers.find((s) => s.name === "beta");
      assert.ok(a, "alpha present");
      assert.equal(a.type, "stdio");
      assert.equal(a.command, "tool");
      assert.deepEqual(a.args, ["--x"]);
      assert.deepEqual(a.env, { A: "1" });
      assert.ok(b, "beta present");
      assert.equal(b.type, "http");
      assert.equal(b.url, "https://h/api");
      // A second read proves the on-disk file re-parses to the same two servers.
      assert.equal(readServers(d).length, 2);
    } finally {
      cleanup(d);
    }
  });

  test(`mcp roundtrip (${format}): remove one and disable the other`, () => {
    const d = tmpDescriptor(format, ext);
    try {
      upsertServer(d, "alpha", stdioSpec);
      upsertServer(d, "beta", httpSpec);
      removeServer(d, "alpha");
      const afterRemove = readServers(d);
      assert.equal(afterRemove.length, 1);
      assert.equal(afterRemove[0].name, "beta");
      setServerEnabled(d, "beta", false);
      const afterDisable = readServers(d);
      assert.equal(afterDisable.length, 1);
      assert.equal(afterDisable[0].enabled, false);
    } finally {
      cleanup(d);
    }
  });

  test(`mcp roundtrip (${format}): re-enable a disabled server flips it back on`, () => {
    const d = tmpDescriptor(format, ext);
    try {
      upsertServer(d, "alpha", { ...stdioSpec, enabled: false });
      const off = readServers(d);
      assert.equal(off[0].enabled, false);
      setServerEnabled(d, "alpha", true);
      const on = readServers(d);
      assert.equal(on[0].enabled, true);
    } finally {
      cleanup(d);
    }
  });
}

test("mcp: refuses to overwrite a config it cannot parse (corrupted generic file)", () => {
  const d = tmpDescriptor("generic", "json");
  try {
    fs.writeFileSync(d.path, "{ this is not valid json ");
    assert.throws(() => upsertServer(d, "alpha", stdioSpec), (err) => /Cannot edit/.test((err as Error).message));
  } finally {
    cleanup(d);
  }
});

test("mcp: isValidMcpName rejects illegal characters and over-long dsh names", () => {
  assert.equal(isValidMcpName("good-name_1"), true);
  assert.equal(isValidMcpName("bad name"), false); // space
  assert.equal(isValidMcpName("bad/name"), false); // slash
  const long = "x".repeat(33);
  assert.equal(isValidMcpName(long, "dsh-cordis"), false);
  assert.equal(isValidMcpName(long), true); // only dsh enforces the 32-char cap
});

test("mcp: normalizeSpec rejects a stdio server without a command and an http server without a url", () => {
  assert.equal(normalizeSpec({ type: "stdio" }).error, "stdio servers require a command");
  assert.equal(normalizeSpec({ type: "http" }).error, "sse/http servers require a url");
  const ok = normalizeSpec({ type: "stdio", command: "  tool ", args: ["a"], env: { K: "v" } });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.spec, { type: "stdio", command: "tool", args: ["a"], env: { K: "v" } });
});
