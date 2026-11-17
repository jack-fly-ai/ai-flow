import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { streamStageLog } from "../src/viewer/routes/runs.js";

// Focused test for the SSE live-log handler: it must emit the stage log as
// `data:` frames (redacted), and tear its timers down when the client drops.
test("SSE streamStageLog pushes the redacted stage log and closes on disconnect", async () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-sse-"));
  const logDir = path.join(runsRoot, "TASK1", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const secret = "password=hunter22";
  fs.writeFileSync(path.join(logDir, "phase1.log"), `hello\n${secret}\n`);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-sse-repo-"));

  const server = http.createServer((req, res) => {
    streamStageLog(req, res, repoRoot, runsRoot, "TASK1", "phase1");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  const chunks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = http.get({ port, path: "/x" }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        chunks.push(c);
        if (chunks.join("").includes("hello")) resolve();
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    // Drop the client shortly after we have data; the handler must clean up.
    setTimeout(() => req.destroy(), 150);
  });

  const body = chunks.join("");
  assert.ok(body.startsWith("retry: 3000"), "SSE stream opens with a retry hint");
  assert.ok(/data: /.test(body), "emits a data: frame");
  assert.ok(body.includes("hello"), "frame carries the log content");
  assert.ok(!body.includes(secret), "secrets are redacted in the streamed frame");

  // No leaked timers: the server must close cleanly once the client is gone.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(runsRoot, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test("SSE streamStageLog survives the log file vanishing mid-stream", async () => {
  // The per-second read() runs inside a setInterval callback: an unguarded fs
  // throw (the log file removed by a reset/delete between existsSync and
  // statSync) would escape as an uncaughtException and kill the VIEWER process.
  // The handler must skip the tick and keep streaming.
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-sse-"));
  const logDir = path.join(runsRoot, "TASK1", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "phase1.log");
  fs.writeFileSync(logFile, "first frame\n");
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-sse-repo-"));

  const server = http.createServer((req, res) => {
    streamStageLog(req, res, repoRoot, runsRoot, "TASK1", "phase1");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  const chunks: string[] = [];
  let response: http.IncomingMessage;
  let client: http.ClientRequest;
  await new Promise<void>((resolve, reject) => {
    client = http.get({ port, path: "/x" }, (res) => {
      response = res;
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        chunks.push(c);
        if (chunks.join("").includes("first frame")) resolve();
      });
      res.on("error", reject);
    });
    client.on("error", reject);
  });

  // Remove the log mid-stream and let at least one more tick fire.
  fs.rmSync(logFile);
  await new Promise<void>((resolve) => setTimeout(resolve, 1500));

  const body = chunks.join("");
  assert.ok(!response!.destroyed, "the SSE connection stays open across the fs race");
  assert.ok(body.includes('"exists":false'), "the next frame reports the missing log instead of crashing");
  // read() died with an uncaughtException inside the interval callback.
  assert.ok(body.includes("first frame"), "the earlier content was streamed before the removal");

  // Drop the client (the connection surviving was the point) so the server can
  // close: server.close() waits for every open connection to end.
  client!.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(runsRoot, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
