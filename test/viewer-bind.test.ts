import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isStageError } from "../src/core/errors.js";
import { startUi } from "../src/viewer/server.js";

/* startUi must translate raw listen() errnos into actionable StageErrors instead
 * of leaking a cryptic "EADDRNOTAVAIL: address not available" to the operator. */

test("startUi: a host that is not a local interface fails with a clear EADDRNOTAVAIL message", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-bind-"));
  // A token is configured (with a valid runner.command) so the bind is allowed
  // to proceed past the non-loopback fail-fast and actually reach listen().
  fs.writeFileSync(
    path.join(repoRoot, "ai-flow.config.json"),
    JSON.stringify({ runner: { command: ["agent", "{promptStdin}"] }, ui: { token: "test" } }),
  );
  // 203.0.113.0/24 (TEST-NET-3) is reserved for documentation and never bound
  // to a real interface, so listen() fails with EADDRNOTAVAIL.
  await assert.rejects(
    startUi(repoRoot, "203.0.113.7", 0),
    (err: unknown) => {
      assert.ok(isStageError(err), "should be a StageError");
      const msg = (err as Error).message;
      assert.match(msg, /not assigned to any network interface/);
      assert.match(msg, /0\.0\.0\.0/);
      return true;
    },
  );
});

test("startUi: a busy port fails with a clear EADDRINUSE message", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-bind-"));
  const squatter = http.createServer();
  await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  const port = (squatter.address() as { port: number }).port;
  try {
    await assert.rejects(
      startUi(repoRoot, "127.0.0.1", port),
      (err: unknown) => {
        assert.ok(isStageError(err), "should be a StageError");
        assert.match((err as Error).message, /already in use/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test("startUi: a non-loopback bind without a token is refused (defense in depth)", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-flow-bind-"));
  // 0.0.0.0 is a non-loopback bind with no auth.tokens / ui.token configured:
  // startUi must refuse rather than expose an unauthenticated control plane.
  await assert.rejects(
    startUi(repoRoot, "0.0.0.0", 0),
    (err: unknown) => {
      assert.ok(isStageError(err), "should be a StageError");
      assert.match((err as Error).message, /non-loopback interface requires authentication/);
      return true;
    },
  );
});
