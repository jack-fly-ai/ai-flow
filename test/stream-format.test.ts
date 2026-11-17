import assert from "node:assert/strict";
import { test } from "node:test";
import { createStreamFormatter, createStreamEventCollector, type StreamEvent } from "../src/agents/streamFormat.js";

const ev = (type: string, payload: Record<string, unknown> = {}): string => JSON.stringify({ type, payload });

/** Drive the formatter (text lines) through a script and flush at the end. */
function format(lines: string[]): string[] {
  const f = createStreamFormatter();
  const out: string[] = [];
  for (const l of lines) out.push(...f.push(l));
  out.push(...f.finish());
  return out;
}

/** Drive the collector (structured events) through a script and flush at the end. */
function collect(lines: string[]): StreamEvent[] {
  const c = createStreamEventCollector();
  for (const l of lines) c.push(l);
  return c.finish();
}

// Non-JSON passthrough (stderr warnings / plain errors stay visible)

test("formatter: non-JSON lines pass through verbatim", () => {
  assert.deepEqual(format(["a plain stderr warning"]), ["a plain stderr warning"]);
});

test("collector: non-JSON lines become a raw event", () => {
  const events = collect(["a plain stderr warning"]);
  assert.deepEqual(events, [{ kind: "raw", text: "a plain stderr warning" }]);
});

// turn.started -> [user] (USER_CLIP truncation)

test("formatter: turn.started emits a [user] line", () => {
  assert.deepEqual(format([ev("turn.started", { input: "do the thing" })]), ["[user] do the thing"]);
});

test("formatter: turn.started clips the input to USER_CLIP (4000)", () => {
  const big = "a".repeat(5000);
  const out = format([ev("turn.started", { input: big })]);
  assert.ok(out[0].startsWith("[user] "));
  assert.ok(out[0].endsWith(" …"));
  assert.equal(out[0].length, "[user] ".length + 4000 + " …".length);
});

test("collector: turn.started emits a user event with clipped text", () => {
  const big = "a".repeat(5000);
  const events = collect([ev("turn.started", { input: big })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "user");
  assert.equal((events[0] as { text: string }).text.length, 4000 + " …".length);
});

// model.streaming: step numbering + reasoning/text aggregation + ordering

test("formatter: reasoning then text deltas aggregate into ordered thinking/assistant lines", () => {
  const out = format([
    ev("turn.started", { input: "do X" }),
    ev("model.streaming", { kind: "reasoning_start", assistantMessageId: "m1" }),
    ev("model.streaming", { kind: "reasoning_delta", assistantMessageId: "m1", delta: "think" }),
    ev("model.streaming", { kind: "reasoning_end", assistantMessageId: "m1" }),
    ev("model.streaming", { kind: "text_start", assistantMessageId: "m1" }),
    ev("model.streaming", { kind: "text_delta", assistantMessageId: "m1", delta: "answer" }),
    ev("model.streaming", { kind: "text_end", assistantMessageId: "m1" }),
  ]);
  assert.deepEqual(out, [
    "[user] do X",
    "── step 1 ──",
    "  thinking: think",
    "  assistant: answer",
  ]);
});

test("collector: reasoning/text deltas become thinking/assistant events with complete flag", () => {
  const events = collect([
    ev("model.streaming", { kind: "reasoning_start", assistantMessageId: "m1" }),
    ev("model.streaming", { kind: "reasoning_delta", assistantMessageId: "m1", delta: "think" }),
    ev("model.streaming", { kind: "reasoning_end", assistantMessageId: "m1" }),
    ev("model.streaming", { kind: "text_start", assistantMessageId: "m1" }),
    ev("model.streaming", { kind: "text_delta", assistantMessageId: "m1", delta: "answer" }),
    ev("model.streaming", { kind: "text_end", assistantMessageId: "m1" }),
  ]);
  assert.equal(events[0].kind, "step");
  assert.equal(events[1].kind, "thinking");
  assert.equal((events[1] as { text: string }).text, "think");
  assert.equal((events[1] as { complete: boolean }).complete, true);
  assert.equal(events[2].kind, "assistant");
  assert.equal((events[2] as { text: string }).text, "answer");
  assert.equal((events[2] as { complete: boolean }).complete, true);
});

test("collector: a message flushed by finish() without an end marker is complete:false", () => {
  const events = collect([
    ev("model.streaming", { kind: "reasoning_start", assistantMessageId: "m1" }),
    ev("model.streaming", { kind: "reasoning_delta", assistantMessageId: "m1", delta: "partial" }),
  ]);
  const thinking = events.find((e) => e.kind === "thinking");
  assert.ok(thinking);
  assert.equal((thinking as { complete: boolean }).complete, false);
});

// Tool pairing: tool_call placeholder + tool.updated result

test("formatter: a tool call followed by its result renders one tool line with ok/ms", () => {
  const out = format([
    ev("model.streaming", { kind: "tool_call", assistantMessageId: "m1", toolCallId: "t1", toolName: "Bash", input: { command: "ls -la", description: "list" } }),
    ev("tool.updated", { kind: "result", toolCallId: "t1", result: { success: true, perf: { totalMs: 1500 } } }),
  ]);
  assert.deepEqual(out, ["── step 1 ──", "  tool: Bash ls -la  # list → ok (1.5s)"]);
});

test("formatter: a failed tool result renders FAILED without an ms suffix", () => {
  const out = format([
    ev("model.streaming", { kind: "tool_call", assistantMessageId: "m1", toolCallId: "t1", toolName: "Read", input: { file_path: "/etc/hosts" } }),
    ev("tool.updated", { kind: "result", toolCallId: "t1", result: { success: false } }),
  ]);
  assert.deepEqual(out, ["── step 1 ──", "  tool: Read /etc/hosts → FAILED"]);
});

// INVARIANT: events is append-only; a tool result updates its placeholder ROW
// IN PLACE (same index), it is never reordered or re-appended.

test("collector: a tool result updates its placeholder row in place (stable, not reordered)", () => {
  const lines = [
    ev("turn.started", { input: "x" }),
    ev("model.streaming", { kind: "tool_call", assistantMessageId: "m1", toolCallId: "t1", toolName: "Bash", input: { command: "echo hi" } }),
    ev("model.streaming", { kind: "text_start", assistantMessageId: "m1" }),
    ev("model.streaming", { kind: "text_delta", assistantMessageId: "m1", delta: "done" }),
    ev("model.streaming", { kind: "text_end", assistantMessageId: "m1" }),
    ev("tool.updated", { kind: "result", toolCallId: "t1", result: { success: true, perf: { totalMs: 800 } } }),
  ];
  const events = collect(lines);
  // tool_call emits a step marker (index N) and THEN the tool placeholder (N+1);
  // the result must mutate that placeholder row in place, never replacing the
  // step nor reordering the array.
  const stepIdx = events.findIndex((e) => e.kind === "step");
  const toolIdx = events.findIndex((e) => e.kind === "tool");
  assert.ok(stepIdx >= 0 && toolIdx >= 0);
  assert.ok(toolIdx > stepIdx, "tool row sits after its step marker, not replacing it");
  const toolRow = events[toolIdx] as { status?: string; summary: string; ms?: number };
  assert.equal(toolRow.status, "ok");
  assert.equal(toolRow.summary, "echo hi");
  assert.equal(toolRow.ms, 800);
  assert.equal(events[events.length - 1].kind, "assistant");
  assert.equal((events[events.length - 1] as { text: string }).text, "done");
});

test("collector: a tool call with no result and no derivable summary is dropped by finish()", () => {
  // toolSummary returns "" for a Bash call with no command, so the filter (which
  // drops tool rows lacking both a summary and a completed result) removes it.
  const events = collect([
    ev("turn.started", { input: "x" }),
    ev("model.streaming", { kind: "tool_call", assistantMessageId: "m1", toolCallId: "t1", toolName: "Bash", input: {} }),
  ]);
  assert.ok(!events.some((e) => e.kind === "tool"), "tool row with empty summary and no result is filtered out");
});

test("collector: an orphan tool result (no prior tool_call) is also dropped by finish()", () => {
  // An unmatched result carries no input-derived summary, so it is filtered the
  // same way as an unresolved placeholder — the stream having lost the tool_call.
  const events = collect([ev("tool.updated", { kind: "result", toolCallId: "t1", result: { success: true } })]);
  assert.ok(!events.some((e) => e.kind === "tool"), "orphan result without a summary is filtered out");
});

test("collector: each distinct message id increments the step counter once", () => {
  const events = collect([
    ev("model.streaming", { kind: "tool_call", assistantMessageId: "m1", toolCallId: "t1", toolName: "Bash", input: {} }),
    ev("model.streaming", { kind: "tool_call", assistantMessageId: "m2", toolCallId: "t2", toolName: "Read", input: { file_path: "/a" } }),
  ]);
  const steps = events.filter((e) => e.kind === "step");
  assert.deepEqual(steps, [{ kind: "step", n: 1 }, { kind: "step", n: 2 }]);
});

// turn.completed + RESPONSE_CLIP truncation

test("formatter: turn.completed emits response and tokens", () => {
  assert.deepEqual(
    format([ev("turn.completed", { response: "final answer", usage: { totalTokens: 123 } })]),
    ["[turn completed] response: final answer · tokens: 123"],
  );
});

test("formatter: turn.completed clips the response to RESPONSE_CLIP (2000)", () => {
  const big = "a".repeat(5000);
  const out = format([ev("turn.completed", { response: big })]);
  assert.ok(out[0].startsWith("[turn completed] response:"));
  assert.ok(out[0].endsWith(" …"));
  assert.equal((out[0].match(/a/g) ?? []).length, 2000);
});

test("collector: turn.completed emits a turn event with optional tokens", () => {
  const events = collect([ev("turn.completed", { response: "final answer", usage: { totalTokens: 123 } })]);
  assert.deepEqual(events, [{ kind: "turn", text: "final answer", tokens: 123 }]);
});

// Message accumulation truncation (CLIP = 20000) on the structured collector

test("collector: an over-long message is clipped to CLIP (20000) with an ellipsis", () => {
  const big = "a".repeat(25_000);
  const events = collect([
    ev("model.streaming", { kind: "reasoning_start", assistantMessageId: "m1" }),
    ev("model.streaming", { kind: "reasoning_delta", assistantMessageId: "m1", delta: big }),
    ev("model.streaming", { kind: "reasoning_end", assistantMessageId: "m1" }),
  ]);
  const thinking = events.find((e) => e.kind === "thinking");
  assert.ok(thinking);
  assert.equal((thinking as { text: string }).text.endsWith(" …"), true);
  assert.equal((thinking as { text: string }).text.length, 20_000 + " …".length);
});

// INVARIANT regression: the events array is APPEND-ONLY. pendingTools stores the
// tool row's numeric INDEX into `events`, so any splice/reorder/positional
// mutation would silently corrupt a tool row. A later tool result (or a whole
// second message) must update the placeholder row IN PLACE, never relocate it.

test("collector: a later tool result never relocates the tool row (append-only)", () => {
  const lines = [
    ev("turn.started", { input: "x" }),
    // message 1: a tool call up front, then reasoning+text deltas, then ends.
    ev("model.streaming", { kind: "tool_call", assistantMessageId: "m1", toolCallId: "t1", toolName: "Bash", input: { command: "echo a" } }),
    ev("model.streaming", { kind: "text_start", assistantMessageId: "m1" }),
    ev("model.streaming", { kind: "reasoning_start", assistantMessageId: "m1" }),
    ev("model.streaming", { kind: "reasoning_delta", assistantMessageId: "m1", delta: "r" }),
    ev("model.streaming", { kind: "text_delta", assistantMessageId: "m1", delta: "t" }),
    ev("model.streaming", { kind: "reasoning_end", assistantMessageId: "m1" }),
    ev("model.streaming", { kind: "text_end", assistantMessageId: "m1" }),
    // message 2: a second tool call + result, interleaved AFTER message 1's tool.
    ev("model.streaming", { kind: "tool_call", assistantMessageId: "m2", toolCallId: "t2", toolName: "Read", input: { file_path: "/b" } }),
    ev("model.streaming", { kind: "text_start", assistantMessageId: "m2" }),
    ev("model.streaming", { kind: "text_end", assistantMessageId: "m2" }),
    ev("tool.updated", { kind: "result", toolCallId: "t1", result: { success: true, perf: { totalMs: 100 } } }),
    ev("tool.updated", { kind: "result", toolCallId: "t2", result: { success: false } }),
  ];
  const events = collect(lines);
  // The Bash tool row was placed right after its step marker; it must still be
  // exactly there, with its result applied in place — a relocation would break it.
  const t1Idx = events.findIndex((e) => e.kind === "tool" && (e as { name?: string }).name === "Bash");
  assert.ok(t1Idx >= 0, "Bash tool row is present");
  const t1 = events[t1Idx] as { kind: "tool"; name: string; status?: string; ms?: number };
  assert.equal(t1.name, "Bash");
  assert.equal(t1.status, "ok");
  assert.equal(t1.ms, 100);
  // The Read/FAILED row is a distinct, later row; both results were applied.
  const t2 = events.find((e) => e.kind === "tool" && (e as { name?: string }).name === "Read") as { status?: string } | undefined;
  assert.ok(t2);
  assert.equal(t2!.status, "FAILED");
  // Exactly two step markers: one per distinct message's first increment event.
  assert.equal(events.filter((e) => e.kind === "step").length, 2);
});
