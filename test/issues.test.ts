import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ISSUES_PER_PAGE,
  ISSUES_STALE_MS,
  issuesSnapshotPath,
  issueGateError,
  readIssuesSnapshot,
  syncIssues,
  type IssuesFetch,
  type IssuesFetchResponse,
  type IssuesSnapshot,
} from "../src/delivery/issues.js";
import { handleRoutes } from "../src/viewer/routes.js";
import { RateLimiter } from "../src/viewer/guards.js";
import { fakeResponse } from "./helpers/units-helpers.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aiflow-issues-"));
}

/** A GitHub-shaped issue (deliberately carrying fields that must NOT survive). */
function ghIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 123,
    title: "Fix the viewer",
    state: "open",
    html_url: "https://github.com/acme/webapp/issues/123",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    user: { login: "alice", id: 42, avatar_url: "https://example.com/a.png" },
    labels: [{ name: "bug" }, { name: "ui" }],
    comments: 3,
    body: "The list should be redacted: password=hunter22",
    node_id: "MDU6SXNzdWUxMjM=",
    url: "https://api.github.com/repos/acme/webapp/issues/123",
    ...overrides,
  };
}

function okResponse(body: unknown): IssuesFetchResponse {
  return { ok: true, status: 200, json: async () => body };
}

/** Collect URLs and serve a scripted list of pages. */
function scriptedFetch(pages: unknown[][]): { fetch: IssuesFetch; urls: string[]; authHeaders: string[]; signals: unknown[] } {
  const urls: string[] = [];
  const authHeaders: string[] = [];
  const signals: unknown[] = [];
  let call = 0;
  const fetch: IssuesFetch = (url, init) => {
    urls.push(url);
    authHeaders.push(init.headers.authorization);
    signals.push(init.signal);
    const page = pages[call] ?? [];
    call += 1;
    return Promise.resolve(okResponse(page));
  };
  return { fetch, urls, authHeaders, signals };
}

// syncIssues: whitelist projection, PR filtering, pagination, atomic write.

test("syncIssues projects a whitelist and never writes the token or raw GitHub fields", async () => {
  const root = tmpRoot();
  const spy = scriptedFetch([[ghIssue()]]);
  const result = await syncIssues({ repoRoot: root, repo: "acme/webapp", token: "ghp_SECRET_TOKEN_VALUE", fetchImpl: spy.fetch });
  assert.equal(result.count, 1);
  assert.equal(result.truncated, false);
  assert.match(result.file, /issues\.json$/);

  const raw = fs.readFileSync(result.file, "utf8");
  assert.ok(!raw.includes("ghp_SECRET_TOKEN_VALUE"), "the token must never reach the snapshot file");
  assert.ok(!raw.includes("node_id"), "raw GitHub metadata must not be persisted");
  assert.ok(!raw.includes("avatar_url"), "raw user object must not be persisted");
  assert.ok(!raw.includes("hunter22"), "secrets must be redacted on write");
  assert.ok(raw.includes("<redacted>"));

  const snapshot = JSON.parse(raw) as IssuesSnapshot;
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.repo, "acme/webapp");
  assert.equal(snapshot.issues.length, 1);
  const entry = snapshot.issues[0];
  assert.deepEqual(Object.keys(entry).sort(), [
    "author", "body", "comments", "createdAt", "htmlUrl", "labels", "number", "state", "title", "updatedAt",
  ]);
  assert.equal(entry.number, 123);
  assert.equal(entry.title, "Fix the viewer");
  assert.equal(entry.state, "open");
  assert.equal(entry.author, "alice");
  assert.deepEqual(entry.labels, ["bug", "ui"]);
  assert.equal(entry.comments, 3);
  assert.equal(entry.htmlUrl, "https://github.com/acme/webapp/issues/123");

  // Only the fixed GitHub host is contacted, with the dedicated bearer token.
  assert.equal(spy.urls.length, 1);
  assert.ok(spy.urls[0].startsWith("https://api.github.com/repos/acme/webapp/issues?"));
  assert.ok(spy.urls[0].includes("state=all"));
  assert.equal(spy.authHeaders[0], "Bearer ghp_SECRET_TOKEN_VALUE");
  assert.ok(spy.signals[0] instanceof AbortSignal, "each request is bounded by a timeout signal");
});

test("syncIssues excludes pull requests and malformed entries", async () => {
  const root = tmpRoot();
  const spy = scriptedFetch([[
    ghIssue({ number: 1 }),
    ghIssue({ number: 2, pull_request: { url: "https://api.github.com/repos/acme/webapp/pulls/2" } }),
    ghIssue({ number: -5 }),
    { number: "not-a-number" },
    null,
    "a string",
  ]]);
  const result = await syncIssues({ repoRoot: root, repo: "acme/webapp", token: "t", fetchImpl: spy.fetch });
  assert.equal(result.count, 1);
  const snapshot = JSON.parse(fs.readFileSync(result.file, "utf8")) as IssuesSnapshot;
  assert.deepEqual(snapshot.issues.map((i) => i.number), [1]);
});

test("syncIssues paginates until a short page, and flags truncation at the page cap", async () => {
  const root = tmpRoot();
  const fullPage = Array.from({ length: ISSUES_PER_PAGE }, (_, i) => ghIssue({ number: i + 1 }));
  const shortPage = [ghIssue({ number: 999 })];
  const spy = scriptedFetch([fullPage, fullPage, shortPage]);
  const result = await syncIssues({ repoRoot: root, repo: "acme/webapp", token: "t", fetchImpl: spy.fetch });
  assert.equal(result.count, 2 * ISSUES_PER_PAGE + 1);
  assert.equal(result.truncated, false);
  assert.deepEqual(spy.urls.map((u) => new URL(u).searchParams.get("page")), ["1", "2", "3"]);

  const capped = scriptedFetch([fullPage, fullPage]);
  const cappedResult = await syncIssues({ repoRoot: tmpRoot(), repo: "acme/webapp", token: "t", maxPages: 2, fetchImpl: capped.fetch });
  assert.equal(cappedResult.truncated, true);
  assert.equal(capped.urls.length, 2, "never walks past the page cap");
});

test("syncIssues refuses a malformed repo (no SSRF via the URL) and a missing token", async () => {
  for (const repo of ["", "acme", "acme/webapp/../../evil", "https://evil.example/x", "acme/webapp?x=1"]) {
    await assert.rejects(
      () => syncIssues({ repoRoot: tmpRoot(), repo, token: "t", fetchImpl: () => Promise.resolve(okResponse([])) }),
      /owner\/name/,
    );
  }
  await assert.rejects(
    () => syncIssues({ repoRoot: tmpRoot(), repo: "acme/webapp", token: "", fetchImpl: () => Promise.resolve(okResponse([])) }),
    /token is required/,
  );
});

test("syncIssues fails cleanly on a non-2xx or a non-list response without echoing the body", async () => {
  const bad: IssuesFetch = () => Promise.resolve({ ok: false, status: 403, json: async () => ({ message: "token=LEAK" }) });
  await assert.rejects(
    () => syncIssues({ repoRoot: tmpRoot(), repo: "acme/webapp", token: "t", fetchImpl: bad }),
    (err) => err instanceof Error && /HTTP 403/.test(err.message) && !err.message.includes("LEAK"),
  );
  const notList: IssuesFetch = () => Promise.resolve(okResponse({ message: "not a list" }));
  await assert.rejects(
    () => syncIssues({ repoRoot: tmpRoot(), repo: "acme/webapp", token: "t", fetchImpl: notList }),
    /was not a list/,
  );
});

// readIssuesSnapshot: missing/corrupt degrade to an actionable note, never throw.

test("readIssuesSnapshot: missing, corrupt and unsupported snapshots degrade to ready:false", () => {
  const root = tmpRoot();
  const missing = readIssuesSnapshot(root);
  assert.equal(missing.ready, false);
  assert.equal(missing.issues.length, 0);
  assert.match(missing.note, /ai-flow sync-issues/);

  fs.mkdirSync(path.dirname(issuesSnapshotPath(root)), { recursive: true });
  fs.writeFileSync(issuesSnapshotPath(root), "{ not json");
  assert.equal(readIssuesSnapshot(root).ready, false);
  assert.match(readIssuesSnapshot(root).note, /corrupt|unreadable/);

  fs.writeFileSync(issuesSnapshotPath(root), JSON.stringify({ version: 99, issues: [] }));
  assert.equal(readIssuesSnapshot(root).ready, false);
  assert.match(readIssuesSnapshot(root).note, /unsupported format/);
});

test("readIssuesSnapshot serves a valid snapshot and marks it stale after 24h", () => {
  const root = tmpRoot();
  const syncedAt = "2026-01-01T00:00:00.000Z";
  const snapshot: IssuesSnapshot = {
    version: 1,
    repo: "acme/webapp",
    syncedAt,
    truncated: true,
    issues: [{ number: 7, title: "A", state: "open", htmlUrl: "", createdAt: "", updatedAt: "", author: "", labels: [], comments: 0, body: "" }],
  };
  fs.mkdirSync(path.dirname(issuesSnapshotPath(root)), { recursive: true });
  fs.writeFileSync(issuesSnapshotPath(root), JSON.stringify(snapshot));

  const now = Date.parse(syncedAt);
  const fresh = readIssuesSnapshot(root, now + 1000);
  assert.equal(fresh.ready, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.truncated, true);
  assert.equal(fresh.repo, "acme/webapp");
  assert.equal(fresh.issues[0].number, 7);

  const stale = readIssuesSnapshot(root, now + ISSUES_STALE_MS + 1);
  assert.equal(stale.stale, true);
  assert.match(stale.note, /older snapshot/);
});

test("readIssuesSnapshot re-redacts and drops dangerous links / bad entries on read", () => {
  const root = tmpRoot();
  const snapshot = {
    version: 1,
    repo: "acme/webapp",
    syncedAt: new Date().toISOString(),
    truncated: false,
    issues: [
      { number: 1, title: "password=hunter22", state: "open", htmlUrl: "javascript:alert(1)", body: "api_key=SECRET", labels: ["x"], comments: 1 },
      { number: 2, title: "ok", state: "closed", htmlUrl: "https://github.com/acme/webapp/issues/2", body: "", labels: [], comments: 0 },
      { number: "bad", title: "should be dropped" },
    ],
  };
  fs.mkdirSync(path.dirname(issuesSnapshotPath(root)), { recursive: true });
  fs.writeFileSync(issuesSnapshotPath(root), JSON.stringify(snapshot));
  const view = readIssuesSnapshot(root);
  assert.equal(view.issues.length, 2, "the malformed entry is dropped");
  assert.ok(!JSON.stringify(view.issues).includes("hunter22"));
  assert.ok(!JSON.stringify(view.issues).includes("SECRET"));
  assert.equal(view.issues[0].htmlUrl, "", "a javascript: URL must never reach the UI");
  assert.equal(view.issues[1].htmlUrl, "https://github.com/acme/webapp/issues/2");
});

// Route: GET /api/issues is read-only, local, and never makes an outbound call.

test("GET /api/issues serves the local snapshot with security headers", async () => {
  const root = tmpRoot();
  const syncedAt = new Date().toISOString();
  const snapshot: IssuesSnapshot = {
    version: 1, repo: "acme/webapp", syncedAt, truncated: false,
    issues: [{ number: 42, title: "From snapshot", state: "open", htmlUrl: "", createdAt: "", updatedAt: "", author: "", labels: [], comments: 0, body: "" }],
  };
  fs.mkdirSync(path.dirname(issuesSnapshotPath(root)), { recursive: true });
  fs.writeFileSync(issuesSnapshotPath(root), JSON.stringify(snapshot));

  const request = {
    method: "GET",
    url: "/api/issues",
    headers: { host: "127.0.0.1:7777" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as http.IncomingMessage;
  const fx = fakeResponse();
  await handleRoutes(request, fx.response, root, path.join(root, ".ai-flow", "runs"), "127.0.0.1", 7777, () => undefined, root, new RateLimiter(600));
  assert.equal(fx.status, 200);
  const body = JSON.parse(fx.body ?? "{}") as { ready: boolean; issues: Array<{ number: number }> };
  assert.equal(body.ready, true);
  assert.equal(body.issues[0].number, 42);
});

test("GET /api/issues on a repo with no snapshot returns an actionable empty view", async () => {
  const root = tmpRoot();
  const request = {
    method: "GET",
    url: "/api/issues",
    headers: { host: "127.0.0.1:7777" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as http.IncomingMessage;
  const fx = fakeResponse();
  await handleRoutes(request, fx.response, root, path.join(root, ".ai-flow", "runs"), "127.0.0.1", 7777, () => undefined, root, new RateLimiter(600));
  assert.equal(fx.status, 200);
  const body = JSON.parse(fx.body ?? "{}") as { ready: boolean; note: string };
  assert.equal(body.ready, false);
  assert.match(body.note, /ai-flow sync-issues/);
});


/* The server-side gate is shared by the HTTP create route and `ai-flow run`.
 * These cases keep the gate ON so CI actually exercises runs-create.ts's 409s. */
async function snapshotWith(root: string, page: Record<string, unknown>[]): Promise<void> {
  const { fetch } = scriptedFetch([page, []]);
  await syncIssues({ repoRoot: root, repo: "acme/webapp", token: "t", fetchImpl: fetch });
}

test("issue gate: a missing snapshot refuses to start a run", () => {
  const root = tmpRoot();
  assert.match(issueGateError(root, "123") ?? "", /No usable issue snapshot/);
});

test("issue gate: a closed issue is refused", async () => {
  const root = tmpRoot();
  await snapshotWith(root, [ghIssue({ number: 123, state: "closed" })]);
  assert.match(issueGateError(root, "123") ?? "", /closed/);
});

test("issue gate: an unlisted number is refused even when the snapshot is truncated", async () => {
  const root = tmpRoot();
  await snapshotWith(root, [ghIssue({ number: 123 })]);
  const file = issuesSnapshotPath(root);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { truncated: boolean };
  raw.truncated = true;
  fs.writeFileSync(file, JSON.stringify(raw), "utf8");
  assert.match(issueGateError(root, "999") ?? "", /not in the local snapshot/);
});

test("issue gate: an open listed issue and an existing run are allowed", async () => {
  const root = tmpRoot();
  await snapshotWith(root, [ghIssue({ number: 123, state: "open" })]);
  assert.equal(issueGateError(root, "123"), null);
  const runDir = path.join(root, ".ai-flow", "runs", "999");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), "{}", "utf8");
  assert.equal(issueGateError(root, "999"), null);
});

test("issue gate: AI_FLOW_ISSUE_GATE=off is an explicit escape hatch", () => {
  const root = tmpRoot();
  const prior = process.env.AI_FLOW_ISSUE_GATE;
  process.env.AI_FLOW_ISSUE_GATE = "off";
  try {
    assert.equal(issueGateError(root, "123"), null);
  } finally {
    if (prior === undefined) delete process.env.AI_FLOW_ISSUE_GATE;
    else process.env.AI_FLOW_ISSUE_GATE = prior;
  }
});
