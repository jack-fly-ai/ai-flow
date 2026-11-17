import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { BodyTooLargeError, MAX_BODY_BYTES, readBody, serveStatic } from "../src/viewer/http.js";
import { createRun } from "../src/viewer/routes/runs-create.js";
import { agentStatus } from "../src/viewer/routes/agent.js";
import { createState, writeState } from "../src/state/store.js";
import { fakeResponse } from "./helpers/units-helpers.js";
import type { Identity } from "../src/auth/auth.js";

// readBody: the 1MB cap is a hard OOM guard on the UNauthenticated viewer. A body
// past it must reject with BodyTooLargeError (the handler answers 413), not let a
// single request buffer the whole payload into memory.

test("readBody rejects a body over 1MB with BodyTooLargeError", async () => {
  const big = Readable.from([Buffer.from("x".repeat(MAX_BODY_BYTES + 1))]) as unknown as http.IncomingMessage;
  await assert.rejects(() => readBody(big), (err) => err instanceof BodyTooLargeError);
});

test("readBody resolves a small JSON body verbatim", async () => {
  const small = Readable.from([Buffer.from('{"id":"TASK1"}')]) as unknown as http.IncomingMessage;
  assert.equal(await readBody(small), '{"id":"TASK1"}');
});

// serveStatic: path-traversal defense. The check is separator-anchored
// (startsWith(staticRoot + sep)) specifically so a sibling directory whose name
// EXTENDS the root (e.g. /a/ui2 when root is /a/ui) cannot slip through a bare
// startsWith(staticRoot). A traversal that escapes the root must be 403.

test("serveStatic refuses path traversal (escape and sibling extension) with 403", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-static-"));
  const siblingName = path.basename(root) + "-evil";
  // (a) escape upward past the root:
  {
    const fx = fakeResponse();
    const handled = serveStatic(fx.response, root, "/../../etc/passwd");
    assert.ok(handled);
    assert.equal(fx.status, 403);
  }
  // (b) the exact sibling-extension case the separator anchoring defends against:
  {
    const fx = fakeResponse();
    const handled = serveStatic(fx.response, root, `/../${siblingName}/x`);
    const resolved = path.normalize(path.join(root, `/../${siblingName}/x`));
    assert.ok(handled);
    assert.equal(fx.status, 403, `sibling ${resolved} must not be served`);
  }
});

test("serveStatic sets the security headers (frame-ancestors/nosniff/no-referrer) on served files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-static-"));
  fs.writeFileSync(path.join(root, "app.js"), "console.log(1)");
  const server = http.createServer((req, res) => {
    serveStatic(res, root, req.url ?? "/");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.get({ port, path: "/app.js" }, (r) => resolve(r));
    req.on("error", reject);
  });
  const body = await new Promise<string>((resolve) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => resolve(d));
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.equal(res.headers["content-security-policy"], "frame-ancestors 'none'");
  assert.equal(body, "console.log(1)");
  server.close();
});

test("agentStatus tolerates a hostile dir argument without throwing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-agent-"));
  // The status path must not crash on injection-shaped input and must yield a
  // valid shape regardless of the dir argument.
  const res = await agentStatus(tmp, "/abs') DROP TABLE session;--");
  assert.equal(res.dir, "/abs') DROP TABLE session;--");
  assert.equal(res.session, null);
  assert.ok("agent" in res && "model" in res);
});

// createRun rev-advance honesty: a Retry/Resume answers 202 only after the NEW
// pipeline advances state.rev past the pre-spawn snapshot. A spawn that dies in
// milliseconds (bad agent command, locked workspace) must be reported as NOT
// started — never as "resumed". Here a prior FAILED record at rev 1 plus a
// no-op startRun (simulating a dead spawn) must yield 200 started:false.

test("createRun does not report a dead spawn as started (rev-advance honesty)", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-cr-repo-"));
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-cr-runs-"));
  const id = "1";
  const runDir = path.join(runsRoot, id);
  const prior = createState(id, runsRoot, "deadbeef");
  prior.status = "failed";
  prior.rev = 1;
  writeState(runDir, prior);

  const identity: Identity = { tenant: "local", role: "operator" };
  const startRun = async (): Promise<void> => {
    /* simulate a spawn that exits before writing state.json */
  };

  const prevWait = process.env.AI_FLOW_START_WAIT_MS;
  process.env.AI_FLOW_START_WAIT_MS = "150";
  try {
    const req = Readable.from([Buffer.from(JSON.stringify({ id }))]) as unknown as http.IncomingMessage;
    const fx = fakeResponse();
    await createRun(req, fx.response, repoRoot, runsRoot, startRun, identity, "tok");
    assert.equal(fx.status, 200);
    const parsed = JSON.parse(fx.body ?? "{}") as { started: boolean };
    assert.equal(parsed.started, false, "a spawn that did not advance rev must not be reported as started");
  } finally {
    if (prevWait === undefined) delete process.env.AI_FLOW_START_WAIT_MS;
    else process.env.AI_FLOW_START_WAIT_MS = prevWait;
  }
});
