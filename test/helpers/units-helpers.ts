import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createStreamFormatter } from "../../src/agents/streamFormat.js";

// The unit suite is split by domain: units-core (agents/config/redact/
// packaging/locks), units-init-runner (init, runner, prompts, taskdev
// parsers, watchdog, markdown) and units-viewer (viewer HTTP surface).
/** The full-read reference parse: what a non-incremental reader would return. */
function fullParseStream(file: string): string {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line && !line.includes('"type":"session.updated"'));
  const formatter = createStreamFormatter();
  const out: string[] = [];
  for (const line of lines) out.push(...formatter.push(line));
  out.push(...formatter.finish());
  return out.join("\n");
}

/** One stream-json line that yields exactly one collected event. */
const TURN_START = '{"type":"turn.started","payload":{"input":"phase 2"}}';
const TURN_DONE = '{"type":"turn.completed","payload":{"response":"ok","usage":{"totalTokens":42}}}';
function fakeRequest(method: string, headers: Record<string, string>): http.IncomingMessage {
  return { method, headers } as unknown as http.IncomingMessage;
}

function fakeResponse(): { response: http.ServerResponse; status: number | null; body: string | null } {
  const out = { response: undefined as unknown as http.ServerResponse, status: null as number | null, body: null as string | null };
  out.response = {
    writeHead(status: number): void {
      out.status = status;
    },
    end(chunk?: string): void {
      out.body = chunk ?? null;
    },
  } as unknown as http.ServerResponse;
  return out;
}
function initFixCommitFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-fixcommit-"));
  const git = (args: string[]): string => {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  return dir;
}

function fixtureCommit(dir: string, file: string, subject: string, body = ""): string {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), "change\n");
  const add = spawnSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8" });
  assert.equal(add.status, 0, `git add failed: ${add.stderr}`);
  const message = body ? `${subject}\n\n${body}` : subject;
  const result = spawnSync("git", ["-C", dir, "commit", "-q", "-m", message], { encoding: "utf8" });
  assert.equal(result.status, 0, `git commit failed: ${result.stderr}`);
  return spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
}

export {
  fullParseStream,
  TURN_START,
  TURN_DONE,
  fakeRequest,
  fakeResponse,
  initFixCommitFixture,
  fixtureCommit,
};
