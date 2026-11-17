export const STAGES = [
  "workspace",
  "phase1",
  "phase2",
  "phase3",
  "phase4",
  "review",
] as const;

export type StageName = (typeof STAGES)[number];

export type StageStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "awaiting_review";

export type RunStatus = "running" | "failed" | "awaiting_review" | "approved";

export const REWORK_STAGES = ["phase1", "phase2", "phase3", "phase4"] as const;

export type ReworkStage = (typeof REWORK_STAGES)[number];

export type GateNumber = 1 | 2 | 3 | 4;

export type GateStatus = "pending" | "passed" | "rejected";

/** What the run waits on when awaiting_review: gate4 = final human audit; clarification = open E1 question; escalation = any other open E2-E7. */
export interface Awaiting {
  kind: "gate4" | "clarification" | "escalation";
  code?: string;
}

export interface ReviewRecord {
  at: string;
  decision: "approve" | "reject" | "message";
  stage?: ReworkStage;
  comment?: string;
}

export interface Rework {
  stage: ReworkStage;
  comment: string;
  at: string;
}

export interface StageState {
  status: StageStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  command?: string;
  error?: string;
}

export interface TestSummary {
  /** "unverified" = the report has no machine-readable totals (no PASS=/FAIL=/SKIP= line): the phase ran but counts can't be confirmed — not a failure, but must not render green. */
  verdict: "passed" | "passed_with_blocked" | "failed" | "unverified";
  skipped: string[];
  pass: number;
  fail: number;
  skip: number;
}

/** Mirror of the task-dev state machine (task-progress). task-progress is the source of truth; this mirror lets the viewer/resume render without re-running the tool. Refreshed after every task-progress call. */
export interface TaskdevMirror {
  mode: "standard" | "replay";
  /** The task-dev workspace checkout (replay mode: the replay tree). */
  workspace: string;
  /** Module pack name picked in phase1 (for example "viewers"). */
  pack?: string;
  replayDir?: string;
  baselineCommit?: string;
  fixCommit?: string;
  phase?: number;
  rounds?: number;
  track?: "auto" | "manual";
  gates?: Partial<Record<GateNumber, GateStatus>>;
  awaiting?: string | null;
  escalationNotes?: string[];
  /** What gate2-reviewed.patch covers: "product" (current) = module product code; absent/"full" = a legacy full-tree snapshot, narrowed via filterPatchToProductSurface at the phase-4 compare. */
  gate2Surface?: "product" | "full";
}

export interface RunArtifacts {
  requirement?: string;
  testCases?: string;
  testReport?: string;
  patch?: string;
  package?: string;
  filelist?: string;
}

export interface RunState {
  id: string;
  /** Monotonic revision, bumped by every writeState (store.ts). The two writers (pipeline, viewer) refuse a write when the on-disk rev is ahead, so a read-modify-write can't silently lose a concurrent update. */
  rev?: number;
  status: RunStatus;
  stage: StageName;
  startedAt: string;
  updatedAt: string;
  baseCommit: string;
  worktree: string;
  stages: Record<StageName, StageState>;
  artifacts: RunArtifacts;
  taskdev: TaskdevMirror;
  /** Agent model override for this run ("provider/model"). */
  model?: string;
  test?: TestSummary;
  awaiting?: Awaiting;
  error: string | null;
  reviews?: ReviewRecord[];
  rework?: Rework;
  /** Total rework rounds requested on this run (S/L: bounded-loop metric). Capped by MAX_REWORK. */
  reworkCount?: number;
  /** Tenant owning this run (isolation edition; src/auth.ts). Set from the run's identity at creation; a legacy record without an owner is unowned and operators-only. */
  owner?: string;
  /** Run-start sha256 fingerprints of the agent's MCP config files; re-checked each phase — a change means the agent edited its tool surface (forbidden) or Manage MCP ran mid-run. */
  mcpHashes?: Record<string, string>;
  /** Gate-4 (task-progress) record outcome, surfaced so an operator can see when the best-effort async write failed. "pending" is set the instant gate 4 is approved; it flips to "ok"/"failed" once recordGate4Passed resolves. */
  gate4Sync?: { status: "pending" | "ok" | "failed"; at: string; error?: string };
  /** State-schema format version, written by createState. readState refuses a
   * strictly-greater version (shape incompatibility); additive fields never bump it. */
  formatVersion?: number;
  /** Prompt template versions used per phase in this run (harness traceability). */
  promptLog?: Array<{ phase: string; version: number; at: string }>;
  /** ai-flow release that produced this run, so replay/eval can attribute behavior to a harness version. */
  harnessVersion?: string;
  /** task-dev tool-contract version this run assumed. */
  toolSchemaVersion?: number;
}

export interface Change {
  status: "A" | "M" | "D";
  path: string;
}

export interface AiFlowConfig {
  /** Preset id from `ai-flow init` (cursor, claude, chatgpt, deepseek). */
  agent?: string;
  /** Model id for the preset. Empty means the CLI's own default. */
  model?: string;
  /**
   * Filled from the preset when `agent` is set. A legacy file may set
   * `command` directly. Tokens: `{promptStdin}`, `{promptArg}`, `{promptFile}`,
   * `{cwd}`, `{model}`.
   */
  runner: {
    command: string[];
    /** Flag used when `command` has no `{model}` token, e.g. "-m" or "--model". Defaults to "-m" for a legacy command. */
    modelFlag?: string;
    /** Optional command that lists models for the viewer dropdown. Omit to use the preset's own list. */
    modelsCommand?: string[];
    /**
     * Explicit model ids for the viewer dropdown and init, winning over every
     * preset-derived source (modelsCommand, listModels, modelsFromConfig).
     * A CLI's locally-readable config rarely knows which plan models are
     * actually entitled server-side; this lets the operator pin the truth.
     */
    models?: string[];
    /** Optional command (with a `{dir}` token) that prints live session status as JSON. */
    statusCommand?: string[];
    /** Optional regex matched against `<command> --version`: runAgent fails fast if the agent binary is missing or wrong-version, before the slow agent run. */
    versionCheck?: string;
  };
  /** Isolation edition (src/auth.ts): per-tenant access. `tokens` maps a bearer token to a tenant; a user sees its own runs only. `operator` names the tenant with operator rights (sees all, manages MCP); defaults to the first token tenant. Absent (no ui.token) = single-tenant. Legacy ui.token stays valid as operator. */
  auth?: {
    tokens?: Record<string, string>;
    operator?: string;
  };
  ui?: {
    host?: string;
    port?: number;
    /** Optional bearer token protecting the viewer. When set, every request must present it (Authorization: Bearer, or ?token=). Leave empty to disable. With auth.tokens configured it stays valid as an operator credential. */
    token?: string;
    /** Per-client viewer ceiling (req/min, sliding window by address). A wedged/hostile tab must not hammer the API; 0 disables. Defaults to 600/min, above the UI's ≈130 req/min polling. */
    rateLimitPerMinute?: number;
  };
  /** Global watchdog: a run over maxMinutes(>0) is force-stopped (SIGTERM agent); 0 disables. When unset, a 720-min (12h) safety default applies so a hung agent can't hold the run lock forever. */
  run?: { maxMinutes?: number };
  taskdev?: {
    /** Absolute path to the task-dev skill directory (contains tools/). */
    skillDir?: string;
    workspaceRoot?: string;
    /** Default module pack when phase1 does not record one (for example "viewers"). */
    pack?: string;
    testTimeoutSeconds?: number;
    designatedHost?: string;
    /**
     * GitHub repository that hosts the tickets, as "owner/name". The phase
     * prompts tell the agent to fetch the issue from THIS repository through
     * its configured GitHub MCP; ai-flow itself never talks to GitHub.
     * Example: "acme/webapp".
     */
    repo?: string;
    /**
     * Optional remote -> pack auto-detection table. When the workspace's git
     * remote matches `remote` (regex, case-insensitive), the pack `pack` is
     * selected without further configuration. Example:
     * `[{ "remote": "github\\.com[:/]acme/app(\\.git)?$", "pack": "app" }]`.
     */
    remotePacks?: Array<{ remote: string; pack: string }>;
    /** Acknowledge the risk of running an unscoped (generic) pack: no module
     * change-surface or pack-check guard applies. Set explicitly so it is a
     * conscious choice, not a silent default (gate 4 remains the only backstop). */
    allowUnscoped?: boolean;
    /**
     * Path prefixes (files or directories, workspace-relative, e.g.
     * [".github/", "infrastructure/"]) that must NEVER change in a run.
     * Enforced mechanically for packs without a dedicated adapter — the
     * generic fallback has no allow-list scope guard, and this deny-list is
     * its backstop before the change can drift toward gate 4 (exported to the
     * pipeline as TASK_FORBID_PATHS). A dedicated adapter's allow-list is
     * strictly stronger, so the list adds nothing there. Empty (default) = off.
     */
    forbidPaths?: string[];
  };
  /**
   * Advanced tuning knobs. Each field falls back to its AI_FLOW_* / TASK_*
   * environment variable when unset, so existing deployments keep working
   * unchanged — set these here only to centralize configuration that is
   * currently scattered across environment variables.
   */
  advanced?: {
    /** git wrapper stdout buffer ceiling in bytes (also AI_FLOW_GIT_MAX_BUFFER). */
    gitMaxBuffer?: number;
    /** Skip installing the agent git ref-lock hook (also AI_FLOW_REF_OK=1). Escape hatch; the hook is the source guard against the agent moving HEAD. */
    refTransactionSkip?: boolean;
    /** OHIF-style viewers module scope prefixes, comma-separated (also TASK_VIEWERS_SCOPE). */
    viewersScope?: string;
    /** Viewers test-area exclusions, comma-separated (also TASK_VIEWERS_TEST_AREA). */
    viewersTestArea?: string;
    /** Viewers pack self-check command (also TASK_VIEWERS_CHECK). */
    viewersCheck?: string;
    /** Viewer createRun wait window (ms) when no pipeline pid was recorded (also AI_FLOW_START_WAIT_MS). */
    startWaitMs?: number;
    /** Viewer createRun wait window (ms) when a live pipeline pid was recorded (also AI_FLOW_START_WAIT_MS_WITH_PID). */
    startWaitMsWithPid?: number;
    /** Refuse runs that use an unscoped (generic) pack instead of only warning;
     * enforces the module scope/check guard as a hard policy. */
    strictUnscoped?: boolean;
  };
}
