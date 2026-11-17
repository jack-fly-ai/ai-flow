import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMaskedEnv } from "../src/agents/mcp.js";

/* The MCP secret-mask contract: the viewer serves every stored env value masked,
 * and an incoming value that equals the mask was NOT re-typed by the operator, so
 * it must be restored from the stored value. This is the security property that
 * "editing one MCP field never overwrites the other fields' secrets with
 * asterisks". Extracted into a pure function so it is unit-testable without the
 * HTTP layer. */

const MASK = "********";

test("applyMaskedEnv: returns undefined when no input env (stored env preserved)", () => {
  assert.equal(applyMaskedEnv(undefined, { A: "secret" }, MASK), undefined);
});

test("applyMaskedEnv: non-mask values pass through unchanged", () => {
  assert.deepEqual(applyMaskedEnv({ A: "real", B: "other" }, { A: "stored", B: "x" }, MASK), { A: "real", B: "other" });
});

test("applyMaskedEnv: a mask value restores the stored secret", () => {
  assert.deepEqual(applyMaskedEnv({ A: MASK, B: "keep" }, { A: "secret", B: "x" }, MASK), { A: "secret", B: "keep" });
});

test("applyMaskedEnv: a mask value with no stored key keeps the mask (no overwrite with asterisks)", () => {
  assert.deepEqual(applyMaskedEnv({ A: MASK }, { B: "x" }, MASK), { A: MASK });
});

test("applyMaskedEnv: a stored env of undefined is treated as no secrets", () => {
  assert.deepEqual(applyMaskedEnv({ A: MASK }, undefined, MASK), { A: MASK });
});

test("applyMaskedEnv: a masked value stays masked when the stored value is the empty string", () => {
  assert.deepEqual(applyMaskedEnv({ A: MASK }, { A: "" }, MASK), { A: "" });
});
