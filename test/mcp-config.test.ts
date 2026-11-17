import { test } from "node:test";
import assert from "node:assert/strict";
import { isSeq, parseDocument } from "yaml";
import {
  DSH_MCP_CLIENT,
  buildDshConfig,
  buildStored,
  entryToSpec,
  findDshMcp,
  fromCodex,
  fromGeneric,
  isValidMcpName,
  migrateGenericLegacy,
  normalizeSpec,
  readMap,
  serversContainer,
} from "../src/agents/mcp-config.js";

/* The MCP config model is the operator-facing security surface (the human edits
 * the agent's tool list here; the agent never does). These tests lock the pure
 * parse/serialize/validate logic extracted into mcp-config.ts. */

test("isValidMcpName: shape + dsh-cordis 32-char cap", () => {
  assert.equal(isValidMcpName("github-mcp_1"), true);
  assert.equal(isValidMcpName("a"), true);
  assert.equal(isValidMcpName("bad name"), false);
  assert.equal(isValidMcpName("bad/name"), false);
  assert.equal(isValidMcpName("bad.name"), false);
  assert.equal(isValidMcpName(""), false);
  assert.equal(isValidMcpName("a".repeat(32), "dsh-cordis"), true);
  assert.equal(isValidMcpName("a".repeat(33), "dsh-cordis"), false);
  // The cap is dsh-cordis only; other formats accept long names.
  assert.equal(isValidMcpName("a".repeat(33), "generic"), true);
  assert.equal(isValidMcpName("a".repeat(33)), true);
});

test("normalizeSpec: stdio needs a command, remote needs a url, trims input", () => {
  assert.deepEqual(normalizeSpec({ type: "stdio", command: "  npx  " }), { spec: { type: "stdio", command: "npx" } });
  assert.equal(normalizeSpec({ type: "stdio" }).error, "stdio servers require a command");
  assert.equal(normalizeSpec({ type: "stdio", command: "   " }).error, "stdio servers require a command");
  // unknown/absent type defaults to stdio
  assert.deepEqual(normalizeSpec({ command: "cmd" }), { spec: { type: "stdio", command: "cmd" } });
  assert.equal(normalizeSpec({ type: "sse" }).error, "sse/http servers require a url");
  assert.deepEqual(normalizeSpec({ type: "http", url: "  https://x  " }), { spec: { type: "http", url: "https://x" } });
});

test("normalizeSpec: carries args/env/enabled only when present", () => {
  assert.deepEqual(
    normalizeSpec({ type: "stdio", command: "cmd", args: ["a"], env: { A: "1" }, enabled: false }),
    { spec: { type: "stdio", command: "cmd", args: ["a"], env: { A: "1" }, enabled: false } },
  );
  // empty args/env are dropped
  assert.deepEqual(normalizeSpec({ type: "stdio", command: "cmd", args: [], env: {} }), { spec: { type: "stdio", command: "cmd" } });
});

test("entryToSpec: preserves every transport-managed field", () => {
  const entry = { name: "s", type: "stdio" as const, command: "cmd", args: ["a"], env: { A: "1" }, enabled: false };
  assert.deepEqual(entryToSpec(entry), { type: "stdio", command: "cmd", args: ["a"], env: { A: "1" }, enabled: false });
  const remote = { name: "s", type: "http" as const, url: "https://x" };
  assert.deepEqual(entryToSpec(remote), { type: "http", url: "https://x" });
});

test("readMap / serversContainer: per-format container keys", () => {
  // generic prefers mcpServers, falls back to legacy mcp
  assert.deepEqual(readMap({ mcpServers: { a: 1 }, mcp: { b: 2 } }, "generic"), { b: 2, a: 1 });
  // codex-toml
  assert.deepEqual(readMap({ mcp_servers: { a: 1 } }, "codex-toml"), { a: 1 });
  // serversContainer creates the right parent
  const obj: Record<string, unknown> = {};
  const c = serversContainer(obj, "generic");
  assert.deepEqual(obj, { mcpServers: {} });
  assert.equal(c, obj.mcpServers);
});

test("fromGeneric: stdio + remote + disabled + non-object", () => {
  assert.deepEqual(fromGeneric("g", { command: "cmd", args: ["a"], env: { A: "1" } }), {
    name: "g",
    type: "stdio",
    command: "cmd",
    args: ["a"],
    env: { A: "1" },
    url: undefined,
    enabled: true,
  });
  assert.deepEqual(fromGeneric("g", { type: "http", url: "https://x" }), {
    name: "g",
    type: "http",
    command: undefined,
    args: undefined,
    env: undefined,
    url: "https://x",
    enabled: true,
  });
  assert.equal(fromGeneric("g", { command: "cmd", disabled: true })?.enabled, false);
  assert.equal(fromGeneric("g", 42), null);
});

test("fromCodex: stdio + http", () => {
  assert.deepEqual(fromCodex("c", { command: "cmd", args: ["a"], env: { A: "1" } }), {
    name: "c",
    type: "stdio",
    command: "cmd",
    args: ["a"],
    env: { A: "1" },
    enabled: true,
  });
  assert.deepEqual(fromCodex("c", { type: "http", url: "https://x" }), { name: "c", type: "http", url: "https://x", enabled: true });
});

/* A parse -> entryToSpec -> buildStored -> parse round-trip must be stable: a
 * re-save of a read-back server never drifts its transport fields. */
const parsers = { generic: fromGeneric, "codex-toml": fromCodex } as const;

test("buildStored round-trips stdio for every format", () => {
  const samples: Record<keyof typeof parsers, [string, Record<string, unknown>]> = {
    generic: ["gen", { command: "cmd", args: ["a", "b"], env: { A: "1" } }],
    "codex-toml": ["cx", { command: "cmd", args: ["a"], env: { A: "1" } }],
  };
  for (const format of Object.keys(samples) as (keyof typeof parsers)[]) {
    const [name, raw] = samples[format];
    const entry = parsers[format](name, raw);
    assert.ok(entry, `${format} parsed`);
    const stored = buildStored(format, name, entryToSpec(entry), null);
    const reparsed = parsers[format](name, stored);
    assert.deepEqual(reparsed, entry, `${format} round-trip`);
  }
});

test("buildStored round-trips remote (generic http)", () => {
  const entry = fromGeneric("g", { type: "http", url: "https://x" });
  assert.ok(entry);
  const stored = buildStored("generic", "g", entryToSpec(entry), null);
  assert.deepEqual(stored, { type: "http", url: "https://x" });
  assert.deepEqual(fromGeneric("g", stored), entry);
});

test("buildStored: disabled reflects the operator switch", () => {
  assert.equal(buildStored("generic", "g", { type: "stdio", command: "c", enabled: false }, null).disabled, true);
  // enabled (default) writes no stale disabled marker
  const s = buildStored("generic", "g", { type: "stdio", command: "c", enabled: true }, null);
  assert.equal("disabled" in s, false);
});

test("buildStored: keeps the agent's own fields (cwd) across a re-save", () => {
  const stored = buildStored("generic", "g", { type: "stdio", command: "new" }, { cwd: "/work", command: "old", args: ["x"] });
  assert.equal(stored.cwd, "/work");
  assert.equal(stored.command, "new");
});

test("migrateGenericLegacy: moves legacy mcp servers, canonical wins a clash", () => {
  const obj: Record<string, unknown> = { mcp: { a: { command: "x" } } };
  const container = serversContainer(obj, "generic");
  migrateGenericLegacy(obj, container);
  assert.deepEqual(obj.mcpServers, { a: { command: "x" } });
  assert.equal("mcp" in obj, false);

  const clash: Record<string, unknown> = { mcp: { a: { from: "legacy" } }, mcpServers: { a: { from: "canonical" } } };
  const c2 = serversContainer(clash, "generic");
  migrateGenericLegacy(clash, c2);
  assert.deepEqual(c2.a, { from: "canonical" });
  assert.equal("mcp" in clash, false);
});

test("buildDshConfig: stdio/http transport mapping, field cleanup, preserved extras", () => {
  const stdio = buildDshConfig({ type: "stdio", command: "cmd", args: ["a"], env: { A: "1" } }, { headers: { X: "1" } }, "srv");
  assert.equal(stdio.serverName, "srv");
  assert.equal(stdio.transport, "stdio");
  assert.equal(stdio.command, "cmd");
  assert.deepEqual(stdio.args, ["a"]);
  assert.deepEqual(stdio.env, { A: "1" });
  assert.equal("url" in stdio, false);
  assert.deepEqual(stdio.headers, { X: "1" }); // agent's own field preserved

  // http AND sse both map to the client's streamable-http, dropping stdio fields
  for (const type of ["http", "sse"] as const) {
    const cfg = buildDshConfig({ type, url: "https://x" }, { command: "c", args: ["a"], env: { A: "1" } }, "srv");
    assert.equal(cfg.transport, "streamable-http");
    assert.equal(cfg.url, "https://x");
    assert.equal("command" in cfg, false);
    assert.equal("args" in cfg, false);
    assert.equal("env" in cfg, false);
  }
  assert.equal(buildDshConfig({ type: "stdio", command: "c", enabled: false }, null, "srv").disabled, true);
  assert.equal("disabled" in buildDshConfig({ type: "stdio", command: "c", enabled: true }, null, "srv"), false);
});

test("findDshMcp: locates an insert by serverName, null when absent", () => {
  const doc = parseDocument(
    `- insert:\n` +
      `    - id: mcp-foo\n` +
      `      name: ${JSON.stringify(DSH_MCP_CLIENT)}\n` +
      `      config:\n` +
      `        serverName: foo\n` +
      `        transport: stdio\n` +
      `        command: c\n`,
  );
  const root = doc.contents;
  assert.ok(isSeq(root));
  const hit = findDshMcp(root, "foo");
  assert.ok(hit);
  assert.equal(hit.index, 0);
  assert.equal(findDshMcp(root, "bar"), null);
});
