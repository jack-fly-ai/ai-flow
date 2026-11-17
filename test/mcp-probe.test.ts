import assert from "node:assert/strict";
import { test } from "node:test";
import { probeMcpServer, type ProbeFetch, type ProbeFetchResponse, type ProbeSpawn } from "../src/agents/mcp-probe.js";
import type { McpServerEntry } from "../src/agents/mcp-config.js";

const STDIO: McpServerEntry = { name: "fs", type: "stdio", command: "npx", args: ["-y", "server-fs"] };
const HTTP: McpServerEntry = { name: "remote", type: "http", url: "https://example.test/mcp" };

const INIT_RESULT = {
  protocolVersion: "2024-11-05",
  serverInfo: { name: "fake-server", version: "2.1.0" },
  capabilities: { tools: {} },
};
const TOOLS_RESULT = { tools: [{ name: "read_file" }, { name: "write_file" }, { name: "list_dir" }] };

const line = (id: number, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });

function fakeFetch(responder: (init: string) => { body: string; status?: number; headers?: Record<string, string> }): ProbeFetch {
  return async (_url, init) => {
    const { body, status = 200, headers = {} } = responder(init.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => body,
    } as ProbeFetchResponse;
  };
}

test("stdio: initialize handshake succeeds, reports server info and tool count", async () => {
  const spawn: ProbeSpawn = async ({ input }) => {
    assert.match(input, /"method":"initialize"/);
    assert.match(input, /"method":"notifications\/initialized"/);
    assert.match(input, /"method":"tools\/list"/);
    return {
      stdout: `${line(1, INIT_RESULT)}\n${line(2, TOOLS_RESULT)}\n`,
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
  };
  const result = await probeMcpServer(STDIO, { spawnImpl: spawn });
  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "2024-11-05");
  assert.equal(result.serverInfo, "fake-server 2.1.0");
  assert.equal(result.tools, 3);
  assert.match(result.detail, /stdio/);
  assert.match(result.detail, /3 tools/);
});

test("stdio: no initialize response is a redacted failure (no raw stderr echo)", async () => {
  const spawn: ProbeSpawn = async () => ({
    stdout: "garbage output",
    stderr: "api_key=SUPERSECRET123 cannot start",
    exitCode: 1,
    timedOut: false,
  });
  const result = await probeMcpServer(STDIO, { spawnImpl: spawn });
  assert.equal(result.ok, false);
  assert.match(result.detail, /No valid initialize response/);
  assert.doesNotMatch(result.detail, /SUPERSECRET123/);
});

test("stdio: timeout returns a bounded failure", async () => {
  const spawn: ProbeSpawn = async () => ({ stdout: "", stderr: "", exitCode: null, timedOut: true });
  const result = await probeMcpServer(STDIO, { spawnImpl: spawn, timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.match(result.detail, /did not respond within 1s/);
});

test("http: initialize over JSON succeeds and follows up for tools", async () => {
  const fetchImpl = fakeFetch((init) => ({
    body: init.includes("tools/list") ? line(2, TOOLS_RESULT) : line(1, INIT_RESULT),
    headers: (init.includes("tools/list") ? {} : { "mcp-session-id": "sess-1" }) as Record<string, string>,
  }));
  const result = await probeMcpServer(HTTP, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.tools, 3);
  assert.match(result.detail, /HTTP/);
});

test("http: SSE-framed initialize response is parsed", async () => {
  const fetchImpl = fakeFetch((init) => ({
    body: init.includes("tools/list") ? `data: ${line(2, TOOLS_RESULT)}\n\n` : `event: message\ndata: ${line(1, INIT_RESULT)}\n\n`,
  }));
  const result = await probeMcpServer(HTTP, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "2024-11-05");
});

test("http: non-2xx status is a bounded failure without echoing the body", async () => {
  const fetchImpl = fakeFetch(() => ({ body: "SECRET challenge body", status: 401 }));
  const result = await probeMcpServer(HTTP, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.detail, /HTTP 401/);
  assert.doesNotMatch(result.detail, /SECRET/);
});

test("http: a JSON-RPC error from the server is surfaced but redacted", async () => {
  const fetchImpl = fakeFetch(() => ({
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "bad api_key=LEAKME" } }),
  }));
  const result = await probeMcpServer(HTTP, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.detail, /bad/);
  assert.doesNotMatch(result.detail, /LEAKME/);
});

test("probe never throws: malformed input yields a redacted failure result", async () => {
  const brokenFetch = (async () => {
    throw new Error("connection refused api_key=NOPE");
  }) as ProbeFetch;
  const result = await probeMcpServer(HTTP, { fetchImpl: brokenFetch });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.detail, /NOPE/);
});

test("stdio: returns on the handshake even when the server never exits (regression)", async () => {
  /* A real MCP stdio server is long-lived: it answers and keeps running. The
   * probe used to wait for `close` and report a bogus 8s timeout. */
  const script = `
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const line of chunk.split('\\n')) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:'2024-11-05',serverInfo:{name:'persistent-fake',version:'1.0'},capabilities:{tools:{}}}}) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{tools:[{name:'one'},{name:'two'}]}}) + '\\n');
    }
  }
});
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 10000);
`;
  const started = Date.now();
  const result = await probeMcpServer(
    { name: "persistent", type: "stdio", command: process.execPath, args: ["-e", script] },
    { timeoutMs: 5_000 },
  );
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.tools, 2);
  assert.equal(result.serverInfo, "persistent-fake 1.0");
  assert.ok(Date.now() - started < 3_000, "must not wait for the persistent process to exit");
});
