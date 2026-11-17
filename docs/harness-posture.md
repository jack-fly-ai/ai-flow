# Harness engineering posture

ai-flow is an agent **harness**: it drives an external LLM agent (Codex/Claude/GLM/Gemini via the `task-dev` tools) through a fixed 6-phase state machine with human-in-the-loop gates. The practices below are what we hold it to; `pnpm run selfcheck` asserts the contracts they depend on (`PROMPT_VERSIONS`, `HARNESS_VERSION`, `TOOL_SCHEMA_VERSION`, `createState` stamping, and the `trace.jsonl` line format).

| Practice | Where it lives | Status |
|---|---|---|
| Isolation / sandbox | `src/auth/auth.ts` (per-tenant dirs, constant-time token), `forbidPaths`, git ref-lock, credential redaction (`src/auth/redact.ts`) | ✅ |
| Permission / HITL | phase1–6 state machine + gate1–4 (`src/orchestrator/phases.ts`, `src/viewer/routes/`) | ✅ |
| Resumability | `state.json` + monotonic `rev` + `rework` + `reset`/`stop` (`src/state/`) | ✅ |
| Context versioning | `PROMPT_VERSIONS` (`src/orchestrator/prompts.ts`); `HARNESS_VERSION` / `TOOL_SCHEMA_VERSION` stamped on every run (`src/state/store.ts`) | ✅ |
| Observability | structured `<runDir>/trace.jsonl` (`src/orchestrator/trace.ts`): prompt, run-start/end (exit code, duration, versions), awaiting, evidence-checked, gate, replay-overreach, rework-cleared | ✅ |
| Deterministic replay | fixed baseline commit + replay-overreach audit in trace; harness decisions are input-determined, not wall-clock | ✅ |
| Tool-contract versioning | `TOOL_SCHEMA_VERSION` recorded per run; bump it on any `task-dev` tool contract change | ✅ |
| Multi-agent adapter | `src/adapters/` (Codex/Claude/GLM/Gemini) | ✅ |
| Eval / regression | `tools/self-check.ts` (`pnpm run selfcheck`) — harness-contract gate; full task-quality eval needs a live agent + API access (out of repo scope) | 🔄 prototype |

Note: an agent harness cannot make the underlying LLM deterministic, so "deterministic replay" here means the harness's own decisions (gates, evidence checks, overreach) are reproducible from a fixed input state, and the trace makes any divergence auditable.
