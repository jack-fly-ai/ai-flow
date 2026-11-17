import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { checkCsrf } from "../src/viewer/guards.js";

function req(method: string, headers: Record<string, string>): http.IncomingMessage {
  return { method, headers } as unknown as http.IncomingMessage;
}
const res = {} as unknown as http.ServerResponse;

test("checkCsrf: non-mutating methods are always allowed", () => {
  assert.equal(checkCsrf(req("GET", { host: "h:7777", origin: "http://evil:7777" }), res), true);
});

test("checkCsrf: mutating request with no Origin is allowed (curl/CLI)", () => {
  assert.equal(checkCsrf(req("POST", { host: "h:7777" }), res), true);
});

test("checkCsrf: mutating request with same-origin Origin is allowed", () => {
  assert.equal(checkCsrf(req("POST", { host: "h:7777", origin: "http://h:7777" }), res), true);
});

test("checkCsrf: mutating request with cross-origin Origin is rejected", () => {
  assert.equal(checkCsrf(req("POST", { host: "h:7777", origin: "http://evil:7777" }), res), false);
});

test("checkCsrf: a non-http Origin scheme is rejected", () => {
  assert.equal(checkCsrf(req("POST", { host: "h:7777", origin: "ftp://h:7777" }), res), false);
});

test("checkCsrf: a valid bearer token supersedes the Origin check (proxy-rewritten Origin)", () => {
  // A reverse proxy may rewrite Origin; when a token was presented the stronger
  // guard must win instead of a false 403.
  assert.equal(
    checkCsrf(req("POST", { host: "h:7777", origin: "http://evil:7777" }), res, { tokenAuthenticated: true }),
    true,
  );
});
