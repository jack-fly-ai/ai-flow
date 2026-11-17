/* Turn a `--output-format stream-json` stdout stream into the readable process
 * log the live-log view shows. The stage log FILE keeps the raw JSON events
 * (append-only, real time); this formatter runs when the viewer reads it back.
 * Event model: turn.started (user prompt), model.streaming (reasoning/text
 * deltas + tool_call, tagged by assistantMessageId), tool.updated (started/result),
 * turn.completed (response + usage). */

export interface StreamFormatter {
  /** Consume one stdout line; returns the readable lines it produced (may be empty). */
  push(line: string): string[];
  /** No more lines — flush any pending buffers. */
  finish(): string[];
}

/** One structured entry for the viewer's rich live-log rendering. */
export type StreamEvent =
  | { kind: "user"; text: string }
  | { kind: "step"; n: number }
  | { kind: "thinking"; text: string; complete: boolean }
  | { kind: "assistant"; text: string; complete: boolean }
  | {
      kind: "tool";
      name: string;
      summary: string;
      input: string;
      status?: "ok" | "FAILED" | "done";
      ms?: number;
    }
  | { kind: "turn"; text: string; tokens?: number }
  | { kind: "raw"; text: string };

/* The operator asked for near-full fidelity: limits exist only to keep a
 * runaway message from bloating the preview, not to summarize content. */
const CLIP = 20_000;
const USER_CLIP = 4_000;
const RESPONSE_CLIP = 2_000;

function clip(text: string, limit = CLIP): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  return trimmed.length > limit ? `${trimmed.slice(0, limit)} …` : trimmed;
}

/* One short human line per tool call (the desktop client collapses them too);
 * the raw input JSON would flood the preview. */
function toolSummary(name: string, raw: unknown): string {
  const input = (raw ?? {}) as Record<string, unknown>;
  const path = (): string => String(input.file_path ?? input.path ?? input.notebook_path ?? "");
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return path();
    case "Bash": {
      const command = clip(String(input.command ?? ""), 400);
      const description = typeof input.description === "string" && input.description ? `  # ${input.description}` : "";
      return `${command}${description}`;
    }
    case "Grep":
      return clip(String(input.pattern ?? ""), 200);
    case "Glob":
      return clip(String(input.pattern ?? ""), 200);
    case "WebFetch":
    case "WebSearch":
      return clip(String(input.url ?? input.query ?? input.query1 ?? ""), 300);
    case "TodoWrite":
      return "(todo list updated)";
    case "AskUserQuestion":
      return clip(JSON.stringify(input.questions ?? input, null, 0), 300);
    default: {
      const keys = Object.keys(input);
      const primary = keys.length > 0 ? String(input[keys[0]!] ?? "") : "";
      return clip(primary || JSON.stringify(input, null, 0), 300);
    }
  }
}

export function createStreamFormatter(): StreamFormatter {
  /* Deltas arrive one token at a time and are only readable once a message
   * completes; cap the raw accumulation so a pathological stream of unending
   * deltas can't grow these maps without bound (emission clips to 600 chars). */
  const ACCUMULATE_CAP = 4000;
  const thinking = new Map<string, string>();
  const text = new Map<string, string>();
  // tool calls awaiting their result, by toolCallId.
  const pendingTools = new Map<string, { name: string; input: string; startedAt?: number }>();
  let step = 0;
  const seenMessages = new Set<string>();

  const emitMessage = (id: string): string[] => {
    const out: string[] = [];
    const thought = clip(thinking.get(id) ?? "");
    if (thought) out.push(`  thinking: ${thought}`);
    const answer = clip(text.get(id) ?? "");
    if (answer) out.push(`  assistant: ${answer}`);
    thinking.delete(id);
    text.delete(id);
    return out;
  };

  return {
    push(line: string): string[] {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let event: { type?: string; payload?: Record<string, unknown> };
      try {
        event = JSON.parse(trimmed);
      } catch {
        // Not JSON (a stderr warning, a plain error) — keep it visible.
        return [trimmed];
      }
      const type = event.type ?? "";
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const out: string[] = [];

      if (type === "turn.started") {
        const input = clip(String(payload.input ?? ""), USER_CLIP);
        out.push(`[user] ${input}`);
        return out;
      }

      if (type === "model.streaming") {
        const kind = String(payload.kind ?? "");
        const id = String(payload.assistantMessageId ?? "?");
        if (!seenMessages.has(id) && (kind === "reasoning_start" || kind === "text_start" || kind === "tool_call")) {
          seenMessages.add(id);
          step += 1;
          out.push(`── step ${step} ──`);
        }
        if (kind === "reasoning_delta" || kind === "text_delta") {
          const key = kind === "reasoning_delta" ? thinking : text;
          // Cap the accumulated message (not just each delta), keeping the tail.
          let acc = (key.get(id) ?? "") + String(payload.delta ?? "");
          if (acc.length > ACCUMULATE_CAP) acc = acc.slice(-ACCUMULATE_CAP);
          key.set(id, acc);
          return out;
        }
        if (kind === "reasoning_end") return out.concat(emitMessage(id));
        if (kind === "text_end") return out.concat(emitMessage(id));
        if (kind === "tool_call") {
          const callId = String(payload.toolCallId ?? "");
          const name = String(payload.toolName ?? "?");
          pendingTools.set(callId, {
            name,
            input: toolSummary(name, payload.input),
          });
          return out;
        }
        return out;
      }

      if (type === "tool.updated") {
        const kind = String(payload.kind ?? "");
        const callId = String(payload.toolCallId ?? "");
        if (kind === "result") {
          const pending = pendingTools.get(callId);
          pendingTools.delete(callId);
          const result = (payload.result ?? {}) as Record<string, unknown>;
          const perf = (result.perf ?? {}) as Record<string, unknown>;
          const ok = result.success === true ? "ok" : result.success === false ? "FAILED" : "done";
          const ms = typeof perf.totalMs === "number" ? ` (${(perf.totalMs / 1000).toFixed(1)}s)` : "";
          if (pending) {
            out.push(`  tool: ${pending.name} ${pending.input} → ${ok}${ms}`);
          } else {
            out.push(`  tool result: ${ok}${ms}`);
          }
        }
        return out;
      }

      if (type === "turn.completed") {
        const usage = (payload.usage ?? {}) as Record<string, unknown>;
        out.push(
          `[turn completed] response: ${clip(String(payload.response ?? ""), RESPONSE_CLIP)}` +
            (typeof usage.totalTokens === "number" ? ` · tokens: ${usage.totalTokens}` : ""),
        );
        return out;
      }

      return out;
    },

    finish(): string[] {
      // A stream cut mid-message (crash, kill) still shows what accumulated.
      const out: string[] = [];
      for (const id of new Set([...thinking.keys(), ...text.keys()])) out.push(...emitMessage(id));
      for (const [, pending] of pendingTools) out.push(`  tool: ${pending.name} ${pending.input} → no result yet`);
      return out;
    },
  };
}

/* Structured variant for the viewer's rich rendering: same event understanding
 * but typed entries; tool rows keep full input JSON (UI-expandable), messages
 * carry a complete flag so in-flight turns render as still-running. */
export interface StreamEventCollector {
  push(line: string): void;
  finish(): StreamEvent[];
}

export function createStreamEventCollector(): StreamEventCollector {
  /* INVARIANT: `events` is strictly APPEND-ONLY — never splice/delete/reorder.
   * `pendingTools` and `completed` hold NUMERIC INDICES into it (a tool's
   * placeholder row is updated in place at its original position), so any
   * positional mutation would silently corrupt tool rows. Filtering happens
   * once, in finish(). */
  const events: StreamEvent[] = [];
  const thinking = new Map<string, string>();
  const text = new Map<string, string>();
  const pendingTools = new Map<string, { index: number; name: string; summary: string; input: string }>();
  let step = 0;
  const seenMessages = new Set<string>();
  /* A tool row whose result already replaced the placeholder "no result yet"
   * — the stored value is the row's INDEX in the append-only `events` array. */
  const completed = new Set<number>();

  const emitMessage = (id: string, complete: boolean): void => {
    const thought = thinking.get(id) ?? "";
    const answer = text.get(id) ?? "";
    thinking.delete(id);
    text.delete(id);
    if (thought.trim()) events.push({ kind: "thinking", text: clip(thought, 20_000), complete });
    if (answer.trim()) events.push({ kind: "assistant", text: clip(answer, 20_000), complete });
  };

  return {
    push(line: string): void {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: { type?: string; payload?: Record<string, unknown> };
      try {
        event = JSON.parse(trimmed);
      } catch {
        events.push({ kind: "raw", text: trimmed });
        return;
      }
      const type = event.type ?? "";
      const payload = (event.payload ?? {}) as Record<string, unknown>;

      if (type === "turn.started") {
        events.push({ kind: "user", text: clip(String(payload.input ?? ""), 4_000) });
        return;
      }

      if (type === "model.streaming") {
        const kind = String(payload.kind ?? "");
        const id = String(payload.assistantMessageId ?? "?");
        if (!seenMessages.has(id) && (kind === "reasoning_start" || kind === "text_start" || kind === "tool_call")) {
          seenMessages.add(id);
          step += 1;
          events.push({ kind: "step", n: step });
        }
        if (kind === "reasoning_delta" || kind === "text_delta") {
          const key = kind === "reasoning_delta" ? thinking : text;
          key.set(id, (key.get(id) ?? "") + String(payload.delta ?? ""));
          return;
        }
        if (kind === "reasoning_end" || kind === "text_end") {
          emitMessage(id, true);
          return;
        }
        if (kind === "tool_call") {
          const callId = String(payload.toolCallId ?? "");
          const name = String(payload.toolName ?? "?");
          pendingTools.set(callId, {
            index: events.length,
            name,
            summary: toolSummary(name, payload.input),
            input: clip(JSON.stringify(payload.input ?? {}, null, 2), 16_000),
          });
          events.push({ kind: "tool", name, summary: "", input: "" });
          return;
        }
        return;
      }

      if (type === "tool.updated") {
        const kind = String(payload.kind ?? "");
        const callId = String(payload.toolCallId ?? "");
        if (kind === "result") {
          const pending = pendingTools.get(callId);
          pendingTools.delete(callId);
          const result = (payload.result ?? {}) as Record<string, unknown>;
          const perf = (result.perf ?? {}) as Record<string, unknown>;
          const status = result.success === true ? "ok" : result.success === false ? "FAILED" : "done";
          const ms = typeof perf.totalMs === "number" ? perf.totalMs : undefined;
          if (pending) {
            const row = events[pending.index!];
            if (row && row.kind === "tool") {
              row.summary = pending.summary;
              row.input = pending.input;
              row.status = status;
              row.ms = ms;
              completed.add(pending.index!);
            } else {
              events.push({ kind: "tool", name: pending.name, summary: pending.summary, input: pending.input, status, ms });
            }
          } else {
            events.push({ kind: "tool", name: "(result)", summary: "", input: "", status, ms });
          }
        }
        return;
      }

      if (type === "turn.completed") {
        const usage = (payload.usage ?? {}) as Record<string, unknown>;
        events.push({
          kind: "turn",
          text: clip(String(payload.response ?? ""), 2_000),
          tokens: typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
        });
        return;
      }
    },

    finish(): StreamEvent[] {
      for (const id of new Set([...thinking.keys(), ...text.keys()])) emitMessage(id, false);
      for (const [, pending] of pendingTools) {
        const row = events[pending.index!];
        if (row && row.kind === "tool") {
          row.summary = pending.summary;
          row.input = pending.input;
        } else {
          events.push({ kind: "tool", name: pending.name, summary: pending.summary, input: pending.input });
        }
      }
      return events.filter((item, index) => !(item.kind === "tool" && !completed.has(index) && !item.summary));
    },
  };
}
