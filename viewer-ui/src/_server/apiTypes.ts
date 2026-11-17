/* The JSON shapes the viewer API serves, owned by the server. The React UI
 * re-exports them from viewer-ui/src/shared.ts (relative import into src/), so
 * a field change is a type error in both trees, not a silent drift. */
import type { RunState, StageState } from "./core/types.js";

/** One stage's progress as shown in the run detail. */
export type StageInfo = StageState;

/* GET /api/issues — the offline GitHub issue snapshot.
 * These shapes live HERE (a Node-free, type-only module) rather than in
 * src/issues.ts: the UI re-exports apiTypes.ts, and importing the sync module
 * would drag node:fs / redact / jsonFile into the DOM-only tsconfig. The
 * runtime module imports these types back, so both trees still share one
 * definition. */
export interface IssueEntry {
  number: number;
  title: string;
  state: string;
  /** Only ever an https://github.com/... URL (validated), or "" — never arbitrary input. */
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  author: string;
  /** Label names only. */
  labels: string[];
  comments: number;
  /** Clipped + redacted issue body, for the expandable detail row. */
  body: string;
}

/** Shape of the on-disk snapshot file (.ai-flow/issues.json). */
export interface IssuesSnapshot {
  version: 1;
  repo: string;
  syncedAt: string;
  /** True when the page cap was hit — the list may be incomplete. */
  truncated: boolean;
  issues: IssueEntry[];
}

/** What GET /api/issues serves. `ready:false` carries an actionable `note`. */
export interface IssuesView {
  ready: boolean;
  repo: string | null;
  syncedAt: string | null;
  /** Snapshot older than ISSUES_STALE_MS — the UI must warn it may be outdated. */
  stale: boolean;
  truncated: boolean;
  issues: IssueEntry[];
  note: string;
}

/** Row of the runs list (GET /api/runs). */
export interface RunSummary {
  id: string;
  /** Owning tenant (isolation edition; null on legacy records — operators only). */
  owner: string | null;
  stage: string;
  status: string;
  startedAt: string;
  mode?: string | null;
  pack?: string | null;
  phase?: number | null;
  gates?: Record<string, string> | null;
  awaiting?: { kind: string; code?: string } | null;
  testVerdict: string | null;
  error: string | null;
  /** True when a rework comment is queued: POST /api/runs may still 409 (a
   *  live rework consumer) even when `status` looks terminal. Lets the UI avoid
   *  offering a Start that the backend will reject. */
  hasRework?: boolean;
  /** Total rework rounds requested (S/L bounded-loop metric); the UI can surface a warning past a threshold. */
  reworkCount?: number;
  /** True when the run's pack has no dedicated adapter (generic fallback): no
   *  scope guard or pack check — gate 4 is the only backstop; UI shows a warning. */
  genericPack?: boolean;
  /** Gate-4 (task-progress) record outcome; non-null when gate 4 was approved and the best-effort async write has resolved (or is pending). Lets the UI flag a failed record. */
  gate4Sync?: { status: string; at: string; error?: string } | null;
}

/** One document tab's content in the run detail. */
export interface RunDoc {
  ready?: boolean;
  markdown?: string;
  files?: Array<{ name: string; content: string }>;
}

// Run detail (GET /api/runs/:id): full state mirror plus documents.
export interface RunDetail {
  state: RunState;
  docs: Record<string, RunDoc>;
  /** Same generic-pack warning as RunSummary, for the detail banner. */
  genericPack?: boolean;
}

/* The viewer's "start the pipeline" hook. The server injects the real
 * detached-spawn impl; tests substitute a no-op or recorder. Lives in shared
 * types (not routes.ts) so route modules reference it without importing the
 * dispatcher. `token` (isolation edition) is the caller's bearer token: the
 * spawned CLI resolves its tenant from it via AI_FLOW_TOKEN, so the run is
 * owned by the same tenant. */
export type StartRun = (repoRoot: string, id: string, model?: string, token?: string) => void;

/* The agent status bar's session object. The field set depends on the agent
 * (statusCommand JSON), so unknown fields are allowed. */
export interface AgentSessionInfo {
  model?: unknown;
  agent?: string;
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  startedAt?: number;
  updatedAt?: number;
  slug?: string;
  provider?: string;
  variant?: string;
  mode?: string;
  status?: string;
  sessionId?: string;
  title?: string;
  [key: string]: unknown;
}

/** Agent status bar payload (GET /api/agent-status). */
export interface AgentStatus {
  dir: string;
  agent: string | null;
  label: string | null;
  model: string | null;
  session: AgentSessionInfo | null;
}

/* Result of the operator's "check availability" probe for one MCP server
 * (POST /api/mcp/:name/probe). `detail` is already redacted server-side. */
export interface McpProbeResult {
  ok: boolean;
  detail: string;
  protocolVersion?: string;
  serverInfo?: string;
  tools?: number;
}

/* The viewer sign-in identity (GET /api/session). Owned here so a backend
 * field change is a type error in the UI (shared.ts re-exports it), not a
 * silent drift between the server's response and the frontend's copy. */
export interface SessionInfo {
  /** False = single-tenant viewer (no auth configured). */
  authEnabled: boolean;
  tenant: string;
  role: "operator" | "user";
}
