import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseDocument, isSeq } from "yaml";
import {
  isValidMcpName,
  listMcpScopes,
  mcpDescriptors,
  normalizeSpec,
  readServers,
  removeServer,
  setServerEnabled,
  upsertServer,
  type McpDescriptor,
} from "../src/agents/mcp.js";

test("mcpDescriptors: claude has user + project, cursor one, chatgpt/deepseek present, unknown none", () => {
  const claude = mcpDescriptors("claude", "/repo");
  assert.equal(claude.length, 2);
  assert.deepEqual(
    claude.map((d) => d.scope),
    ["user", "project"],
  );
  assert.equal(claude[1].requiresApproval, true);

  const cursor = mcpDescriptors("cursor", "/repo");
  assert.equal(cursor.length, 1);
  assert.equal(cursor[0].scope, "user");

  assert.equal(mcpDescriptors("chatgpt", "/repo").length, 2);
  assert.equal(mcpDescriptors("deepseek", "/repo")[0].verified, true);
  assert.equal(mcpDescriptors("deepseek", "/repo")[0].format, "dsh-cordis");
  assert.equal(mcpDescriptors("nope", "/repo").length, 0);
});

test("isValidMcpName accepts and rejects", () => {
  assert.equal(isValidMcpName("my-server_1"), true);
  assert.equal(isValidMcpName("bad name"), false);
  assert.equal(isValidMcpName("bad/name"), false);
  assert.equal(isValidMcpName(""), false);
});

test("isValidMcpName enforces the 32-char dsh-cordis limit only for that format", () => {
  const short = "a".repeat(32);
  const long = "a".repeat(33);
  assert.equal(isValidMcpName(short, "dsh-cordis"), true);
  assert.equal(isValidMcpName(long, "dsh-cordis"), false);
  assert.equal(isValidMcpName(long, "generic"), true, "other formats have no length cap");
  assert.equal(isValidMcpName(long), true, "no format given keeps the legacy behavior");
});

test("normalizeSpec requires command for stdio and url for sse/http", () => {
  assert.equal(normalizeSpec({ type: "stdio" }).error, "stdio servers require a command");
  assert.equal(normalizeSpec({ type: "sse" }).error, "sse/http servers require a url");
  const stdio = normalizeSpec({ type: "stdio", command: "npx", args: ["-y"], env: { A: "1" } });
  assert.deepEqual(stdio.spec, { type: "stdio", command: "npx", args: ["-y"], env: { A: "1" } });
  const http = normalizeSpec({ type: "http", url: "https://x/mcp" });
  assert.deepEqual(http.spec, { type: "http", url: "https://x/mcp" });
});

test("generic round trip preserves unrelated top-level keys", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-"));
  const file = path.join(tmp, "config.json");
  fs.writeFileSync(file, JSON.stringify({ other: 42 }));
  const descriptor: McpDescriptor = {
    path: file,
    format: "generic",
    scope: "user",
    requiresApproval: false,
    verified: true,
  };

  upsertServer(descriptor, "files", { type: "stdio", command: "npx", args: ["-y", "srv"] });
  let servers = readServers(descriptor);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "files");
  assert.deepEqual(servers[0].args, ["-y", "srv"]);

  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.other, 42);
  assert.ok(after.mcpServers);

  upsertServer(descriptor, "web", { type: "http", url: "https://x/mcp" });
  servers = readServers(descriptor);
  assert.equal(servers.length, 2);

  removeServer(descriptor, "files");
  servers = readServers(descriptor);
  assert.deepEqual(
    servers.map((s) => s.name),
    ["web"],
  );
});

test("generic migrates the legacy `mcp` key into mcpServers on upsert", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-"));
  const file = path.join(tmp, "config.json");
  // A file that keeps its servers under the alternate `mcp` key.
  fs.writeFileSync(file, JSON.stringify({ other: 42, mcp: { legacy: { command: "npx", args: ["-y", "old"] } } }));
  const descriptor: McpDescriptor = {
    path: file,
    format: "generic",
    scope: "user",
    requiresApproval: false,
    verified: true,
  };

  upsertServer(descriptor, "fresh", { type: "stdio", command: "srv" });
  const after = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.equal(after.other, 42);
  assert.equal(after.mcp, undefined, "the legacy mcp key is dropped");
  const servers = readServers(descriptor);
  assert.deepEqual(
    servers.map((s) => s.name).sort(),
    ["fresh", "legacy"],
    "legacy entries moved into mcpServers",
  );
});

test("generic removes a server that only lives under the legacy `mcp` key", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-"));
  const file = path.join(tmp, "config.json");
  fs.writeFileSync(file, JSON.stringify({ mcp: { legacy: { command: "npx" } } }));
  const descriptor: McpDescriptor = {
    path: file,
    format: "generic",
    scope: "user",
    requiresApproval: false,
    verified: true,
  };

  removeServer(descriptor, "legacy");
  const after = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.equal(after.mcp, undefined);
  assert.deepEqual(readServers(descriptor), [], "no ghost entry remains");
});



test("codex-toml reads/writes [mcp_servers] and preserves other tables", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-"));
  const file = path.join(tmp, "config.toml");
  const descriptor: McpDescriptor = {
    path: file,
    format: "codex-toml",
    scope: "user",
    requiresApproval: false,
    verified: true,
  };

  fs.writeFileSync(file, 'model = "gpt-5"\n\n[mcp_servers.hub]\nurl = "https://old"\n');

  upsertServer(descriptor, "hub", { type: "http", url: "https://new" });
  const servers = readServers(descriptor);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].url, "https://new");

  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /\[mcp_servers\.hub\]/);
  assert.match(text, /model = "gpt-5"/); // unrelated table preserved
  assert.match(text, /url = "https:\/\/new"/);

  upsertServer(descriptor, "fs", { type: "stdio", command: "npx", args: ["-y", "srv"], env: { K: "v" } });
  const fsServer = readServers(descriptor).find((s) => s.name === "fs");
  assert.equal(fsServer?.command, "npx");
  assert.deepEqual(fsServer?.args, ["-y", "srv"]);
  assert.deepEqual(fsServer?.env, { K: "v" });
});



test("dsh-cordis reads/writes cordis-plugin inserts and preserves the rest of the file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-"));
  const file = path.join(tmp, "cordis.patch.yml");
  // A realistic headless patch: a non-MCP entry plus a github-mcp MCP insert,
  // with a leading comment that must survive our edit.
  fs.writeFileSync(
    file,
    [
      "# dsh headless patch layer",
      "- id: llm-pi-ai",
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      "  config:",
      "    providers:",
      "      qwen:",
      "        apiKeyEnv: QWEN_API_KEY",
      "- insert:",
      "    - id: github-mcp",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: github-mcp",
      "        transport: streamable-http",
      "        url: http://10.2.2.34:7770/mcp",
      "",
    ].join("\n"),
  );
  const descriptor: McpDescriptor = {
    path: file,
    format: "dsh-cordis",
    scope: "user",
    requiresApproval: false,
    verified: true,
  };

  let servers = readServers(descriptor);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "github-mcp");
  assert.equal(servers[0].type, "http");
  assert.equal(servers[0].url, "http://10.2.2.34:7770/mcp");

  // Add a stdio server.
  upsertServer(descriptor, "myfs", {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/repo"],
    env: { TOKEN: "abc" },
  });
  servers = readServers(descriptor);
  assert.equal(servers.length, 2);
  const myfs = servers.find((s) => s.name === "myfs");
  assert.equal(myfs?.command, "npx");
  assert.deepEqual(myfs?.args, ["-y", "@modelcontextprotocol/server-filesystem", "/repo"]);
  assert.deepEqual(myfs?.env, { TOKEN: "abc" });
  // The non-MCP entry and the comment survive.
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /# dsh headless patch layer/);
  assert.match(text, /llm-pi-ai/);
  assert.match(text, /QWEN_API_KEY/);

  // Editing the existing github-mcp server keeps its plugin id.
  upsertServer(descriptor, "github-mcp", { type: "http", url: "http://10.2.2.34:7770/v2/mcp" });
  const githubMcp = readServers(descriptor).find((s) => s.name === "github-mcp");
  assert.equal(githubMcp?.url, "http://10.2.2.34:7770/v2/mcp");
  assert.match(fs.readFileSync(file, "utf8"), /id: github-mcp/);

  // Remove the added server; github-mcp remains.
  removeServer(descriptor, "myfs");
  servers = readServers(descriptor);
  assert.deepEqual(
    servers.map((s) => s.name),
    ["github-mcp"],
  );
  assert.match(fs.readFileSync(file, "utf8"), /QWEN_API_KEY/);
});

test("listMcpScopes reads from real paths (project scope uses repoRoot)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-"));
  const scopes = listMcpScopes("claude", tmp);
  assert.equal(scopes.length, 2);
  const project = scopes.find((s) => s.scope === "project");
  assert.ok(project && project.path.startsWith(tmp));
});

test("normalizeSpec preserves enabled", () => {
  const on = normalizeSpec({ type: "stdio", command: "npx", enabled: true });
  assert.equal(on.spec?.enabled, true);
  const off = normalizeSpec({ type: "stdio", command: "npx", enabled: false });
  assert.equal(off.spec?.enabled, false);
});

test("generic writes/reads the disabled flag via setServerEnabled", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-"));
  const file = path.join(tmp, "config.json");
  const descriptor: McpDescriptor = {
    path: file,
    format: "generic",
    scope: "user",
    requiresApproval: false,
    verified: true,
  };
  upsertServer(descriptor, "fs", { type: "stdio", command: "npx", args: ["-y", "srv"], enabled: false });
  let servers = readServers(descriptor);
  assert.equal(servers.find((s) => s.name === "fs")?.enabled, false);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.mcpServers.fs.disabled, true);

  // Re-enable keeps the rest of the config intact.
  setServerEnabled(descriptor, "fs", true);
  servers = readServers(descriptor);
  const fsServer = servers.find((s) => s.name === "fs");
  assert.equal(fsServer?.enabled, true);
  assert.deepEqual(fsServer?.args, ["-y", "srv"]);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.fs.disabled, undefined);
});

test("dsh-cordis writes/reads disabled under plugin config", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-"));
  const file = path.join(tmp, "cordis.patch.yml");
  const descriptor: McpDescriptor = {
    path: file,
    format: "dsh-cordis",
    scope: "user",
    requiresApproval: false,
    verified: true,
  };
  upsertServer(descriptor, "myfs", {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/repo"],
    env: { TOKEN: "abc" },
    enabled: false,
  });
  let servers = readServers(descriptor);
  assert.equal(servers.find((s) => s.name === "myfs")?.enabled, false);
  assert.match(fs.readFileSync(file, "utf8"), /disabled: true/);

  setServerEnabled(descriptor, "myfs", true);
  servers = readServers(descriptor);
  assert.equal(servers.find((s) => s.name === "myfs")?.enabled, true);
  assert.equal(fs.readFileSync(file, "utf8").includes("disabled: true"), false);
});

test("setServerEnabled throws for an unknown server", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-"));
  const file = path.join(tmp, "config.json");
  const descriptor: McpDescriptor = {
    path: file,
    format: "generic",
    scope: "user",
    requiresApproval: false,
    verified: true,
  };
  assert.throws(() => setServerEnabled(descriptor, "ghost", true), /not found/);
});

test("codex-toml writes/reads the disabled flag and stays valid", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-"));
  const file = path.join(tmp, "config.toml");
  const descriptor: McpDescriptor = {
    path: file,
    format: "codex-toml",
    scope: "user",
    requiresApproval: false,
    verified: true,
  };
  upsertServer(descriptor, "hub", { type: "http", url: "https://x", enabled: false });
  let servers = readServers(descriptor);
  assert.equal(servers.find((s) => s.name === "hub")?.enabled, false);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /disabled\s*=\s*true/);

  setServerEnabled(descriptor, "hub", true);
  servers = readServers(descriptor);
  assert.equal(servers.find((s) => s.name === "hub")?.enabled, true);
  assert.equal(fs.readFileSync(file, "utf8").includes("disabled"), false);
});

test("dsh-cordis creates a valid pure-YAML file when none exists", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-"));
  const file = path.join(tmp, "cordis.patch.yml");
  const descriptor: McpDescriptor = {
    path: file,
    format: "dsh-cordis",
    scope: "user",
    requiresApproval: false,
    verified: true,
  };
  assert.equal(fs.existsSync(file), false);
  upsertServer(descriptor, "myfs", { type: "stdio", command: "npx", args: ["-y", "x"], env: { K: "v" } });
  assert.equal(fs.existsSync(file), true);

  // The written file must be valid, re-parseable pure YAML (no JSON leakage).
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  assert.ok(isSeq(doc.contents), "cordis.patch.yml must be a YAML sequence");
  const servers = readServers(descriptor);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "myfs");
  assert.equal(servers[0].command, "npx");
  assert.deepEqual(servers[0].args, ["-y", "x"]);
  assert.deepEqual(servers[0].env, { K: "v" });
});

test("dsh-cordis edit keeps comment, non-MCP entries, and re-parses as valid YAML", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-"));
  const file = path.join(tmp, "cordis.patch.yml");
  fs.writeFileSync(
    file,
    [
      "# dsh headless patch layer",
      "- id: llm-pi-ai",
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      "  config:",
      "    providers:",
      "      qwen:",
      "        apiKeyEnv: QWEN_API_KEY",
      "- insert:",
      "    - id: github-mcp",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: github-mcp",
      "        transport: streamable-http",
      "        url: http://10.2.2.34:7770/mcp",
      "",
    ].join("\n"),
  );
  const descriptor: McpDescriptor = {
    path: file,
    format: "dsh-cordis",
    scope: "user",
    requiresApproval: false,
    verified: true,
  };

  // Edit the existing github-mcp server: change url and flip disabled.
  upsertServer(descriptor, "github-mcp", { type: "http", url: "http://10.2.2.34:7770/v2/mcp", enabled: false });

  const text = fs.readFileSync(file, "utf8");
  // Still valid YAML after the edit.
  const doc = parseDocument(text);
  assert.ok(isSeq(doc.contents));
  // Comment and the unrelated non-MCP entry survive.
  assert.match(text, /# dsh headless patch layer/);
  assert.match(text, /llm-pi-ai/);
  assert.match(text, /QWEN_API_KEY/);
  // New url and disabled flag applied.
  assert.match(text, /v2\/mcp/);
  assert.match(text, /disabled: true/);
  assert.match(text, /id: github-mcp/);

  const servers = readServers(descriptor);
  const githubMcp = servers.find((s) => s.name === "github-mcp");
  assert.equal(githubMcp?.url, "http://10.2.2.34:7770/v2/mcp");
  assert.equal(githubMcp?.enabled, false);
});

test("generic type switch (stdio -> http -> stdio) stays internally consistent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-"));
  const file = path.join(tmp, "config.json");
  const descriptor: McpDescriptor = {
    path: file,
    format: "generic",
    scope: "user",
    requiresApproval: false,
    verified: true,
  };
  upsertServer(descriptor, "svc", { type: "stdio", command: "npx", args: ["-y", "srv"] });
  let svc = readServers(descriptor).find((s) => s.name === "svc");
  assert.equal(svc?.type, "stdio");
  assert.equal(svc?.command, "npx");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.svc.type, "stdio");

  upsertServer(descriptor, "svc", { type: "http", url: "https://x/mcp" });
  svc = readServers(descriptor).find((s) => s.name === "svc");
  assert.equal(svc?.type, "http");
  assert.equal(svc?.url, "https://x/mcp");
  const afterHttp = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.svc;
  assert.equal(afterHttp.type, "http");
  assert.equal(afterHttp.url, "https://x/mcp");
  assert.equal(afterHttp.command, undefined);
  assert.equal(afterHttp.args, undefined);

  upsertServer(descriptor, "svc", { type: "stdio", command: "npx" });
  svc = readServers(descriptor).find((s) => s.name === "svc");
  assert.equal(svc?.type, "stdio");
  assert.equal(svc?.command, "npx");
  assert.equal(svc?.url, undefined);
  const afterStdio = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.svc;
  assert.equal(afterStdio.type, "stdio");
  assert.equal(afterStdio.url, undefined);
});

test("MCP writes are atomic: no temp file left behind and existing permissions preserved", () => {
  // A viewer crash mid-write must not leave a truncated MCP config (which
  // would break the agent), and the file's permission bits must survive.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-mcp-atomic-"));
  const file = path.join(tmp, "config.json");
  fs.writeFileSync(file, JSON.stringify({ other: 42 }));
  fs.chmodSync(file, 0o600); // restrictive, so a write that drops the mode is visible
  const descriptor: McpDescriptor = {
    path: file,
    format: "generic",
    scope: "user",
    requiresApproval: false,
    verified: true,
  };
  upsertServer(descriptor, "srv", { type: "stdio", command: "npx" });
  // No stray temp files from the atomic rename.
  assert.deepEqual(
    fs.readdirSync(tmp).filter((name) => name.includes(".tmp-")),
    [],
  );
  // Content round-trips and the mode was preserved (0o600, not the umask default).
  const servers = readServers(descriptor);
  assert.equal(servers[0].name, "srv");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
