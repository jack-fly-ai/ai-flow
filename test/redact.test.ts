import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, createLineRedactor, redact } from "../src/auth/redact.js";

// ESC (U+001B) generated at runtime so the source stays ASCII.
const ESC = String.fromCharCode(27);

test("redact: strips ANSI CSI sequences", () => {
  assert.equal(redact(`${ESC}[31merror${ESC}[0m`), "error");
});

test("redact: masks key=value secrets", () => {
  assert.equal(redact("password=hunter2"), "password=<redacted>");
  assert.equal(redact("api_token=abc123"), "api_token=<redacted>");
  // Free-form text (GitHub issue bodies) uses these spellings too.
  assert.equal(redact("api_key=sk-123"), "api_key=<redacted>");
  assert.equal(redact("api-key: sk-123"), "api-key:<redacted>");
});

test("redact: masks Authorization/Cookie headers", () => {
  assert.equal(redact("Authorization: Bearer xyz"), "Authorization: <redacted>");
  assert.equal(redact("Cookie: sid=abc"), "Cookie: <redacted>");
});

test("redact: masks URL credentials", () => {
  assert.equal(redact("https://user:pass@example.com"), "https://user<redacted>@example.com");
});

test("redact: masks query-string secrets", () => {
  assert.equal(redact("https://x.com/p?api_key=sk-123&b=2"), "https://x.com/p?api_key=<redacted>&b=2");
  assert.equal(redact("?access_token=zzz"), "?access_token=<redacted>");
});

test("redact: masks AI_FLOW_TOKEN", () => {
  assert.equal(redact("AI_FLOW_TOKEN=abc123"), "AI_FLOW_TOKEN=<redacted>");
});

test("redact: masks JSON secret values", () => {
  assert.equal(redact('"api_key": "sk-123"'), '"api_key": "<redacted>"');
});

test("redact: masks PEM private key blocks", () => {
  const blocked = "before\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\nafter";
  assert.equal(redact(blocked), "before\n<redacted private key>\nafter");
});

test("clip: redacts and returns the tail", () => {
  const out = clip("x".repeat(600) + "password=secret", 50);
  assert.ok(!out.includes("secret"));
  assert.ok(out.length <= 50);
});

test("createLineRedactor: a secret split across chunk boundaries is still redacted", () => {
  const lines: string[] = [];
  const red = createLineRedactor((line) => lines.push(line));
  red.push("pass"); // partial line held until the newline
  red.push("word=abc123\n"); // completes the line
  red.flush();
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith("password=<redacted>"));
});

/* A multi-line PEM private-key block must be accumulated between BEGIN and END
 * and redacted as one unit; per-line redaction cannot match the whole block. */
test("createLineRedactor: a multi-line PEM block is redacted as a whole", () => {
  const lines: string[] = [];
  const red = createLineRedactor((line) => lines.push(line));
  red.push("-----BEGIN RSA PRIVATE KEY-----\n");
  red.push("MIIEogIBAAKCAQEAexample\n");
  red.push("morekeyline\n");
  red.push("-----END RSA PRIVATE KEY-----\n");
  red.push("after\n");
  red.flush();
  const joined = lines.join("");
  assert.ok(joined.includes("<redacted private key>"), "PEM block must be redacted whole");
  assert.ok(!joined.includes("MIIEogIBAAKCAQEAexample"), "key material must not leak");
  assert.ok(joined.includes("after"));
});

test("createLineRedactor: a PEM block split across chunk boundaries is still redacted", () => {
  const lines: string[] = [];
  const red = createLineRedactor((line) => lines.push(line));
  red.push("-----BEGIN RS"); // BEGIN split across two pushes
  red.push("A PRIVATE KEY-----\nkeyline\n-----END RSA PRIVATE KEY-----\nafter\n");
  red.flush();
  const joined = lines.join("");
  assert.ok(joined.includes("<redacted private key>"));
  assert.ok(!joined.includes("keyline"));
});
