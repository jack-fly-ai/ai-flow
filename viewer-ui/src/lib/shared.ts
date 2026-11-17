/* Shared types, constants and pure helpers for the viewer UI; page components
 * stay plain-prop. */

export const STAGES = ["workspace", "phase1", "phase2", "phase3", "phase4", "review"] as const;
export type Stage = (typeof STAGES)[number];

export const LABELS: Record<Stage, string> = {
  workspace: "Workspace",
  phase1: "Requirement",
  phase2: "Implementation",
  phase3: "Testing",
  phase4: "Deliverables",
  review: "Manual review",
};

/* API shapes are owned by the server; one definition for both trees. */
export type { AgentSessionInfo, AgentStatus, IssueEntry, IssuesView, McpProbeResult, RunDetail, RunSummary, SessionInfo, StageInfo } from "@server/apiTypes";
export type { StageStatus } from "@server/core/types";

export const REWORK_STAGES = [
  ["phase1", "Phase 1 · Requirement"],
  ["phase2", "Phase 2 · Implementation"],
  ["phase3", "Phase 3 · Testing"],
  ["phase4", "Phase 4 · Deliverables"],
] as const;
export type ReworkStage = (typeof REWORK_STAGES)[number][0];

/** Which document tab shows a stage's primary artifacts (the one opened when the
 * stage is clicked in the timeline). */
export const STAGE_TAB: Record<Stage, string> = {
  workspace: "ticket",
  phase1: "requirement",
  phase2: "review",
  phase3: "testPlan",
  phase4: "deliverables",
  review: "deliverables",
};

/** Document tab keys and labels, in display order. */
export const DOC_TABS: Record<string, string> = {
  liveLog: "Live log",
  ticket: "Ticket",
  requirement: "Requirement",
  review: "Review findings",
  testCases: "Test cases",
  testPlan: "Test plan",
  testReport: "Test report",
  handoff: "Handoff",
  clarifications: "Clarifications",
  deliverables: "Deliverables",
};

/* A stage yields several artifacts, so the timeline→document link is 1:N, not 1:1.
 * These maps record provenance — which documents each stage produces, and (reversed)
 * which stage produced a given document tab. The viewer uses them to highlight a
 * stage's sibling documents together and to mark the producing stage for any open
 * doc, making the process→artifact relationship explicit instead of hiding it
 * behind a single representative doc. Derived from the stage table in AGENTS.md;
 * the review stage consumes the deliverables doc rather than producing one, so it
 * intentionally lists none. */
/* Membership only. Display order is derived from DOC_TABS so the timeline's
 * per-stage chips and the tab bar can never drift apart — the hand-written order
 * used to put Test cases after plan/report here while DOC_TABS lists it first. */
const STAGE_DOC_SETS: Record<Stage, string[]> = {
  workspace: ["ticket"],
  phase1: ["requirement", "clarifications"],
  phase2: ["review", "handoff"],
  phase3: ["testPlan", "testReport", "testCases"],
  phase4: ["deliverables"],
  review: [],
};

const DOC_DISPLAY_ORDER = Object.keys(DOC_TABS);

/** Documents each stage produced, ordered to match the document tab bar. */
export const STAGE_DOCS: Record<Stage, string[]> = Object.fromEntries(
  STAGES.map((stage) => [stage, DOC_DISPLAY_ORDER.filter((doc) => STAGE_DOC_SETS[stage].includes(doc))]),
) as Record<Stage, string[]>;

/** Document tab → the stage that produced it. */
export const DOC_STAGE: Record<string, Stage> = (() => {
  const map: Record<string, Stage> = {};
  STAGES.forEach((stage) => {
    STAGE_DOCS[stage].forEach((doc) => {
      map[doc] = stage;
    });
  });
  return map;
})();

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local wall clock as MM/DD/YYYY HH:MM:SS */
export function formatLocalDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}/${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Compact MM/DD HH:MM for tight list rows */
export function formatShortDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function statusColor(status: string): "default" | "success" | "error" | "warning" | "info" {
  switch (status) {
    case "passed":
      return "success";
    case "failed":
      return "error";
    case "running":
    case "passed_with_blocked":
      return "warning";
    case "awaiting_review":
      return "info";
    case "approved":
      return "success";
    case "unverified":
    case "skipped":
    case "pending":
      return "default";
    default:
      return "default";
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "passed_with_blocked":
      return "Passed with blocked";
    case "awaiting_review":
      return "Awaiting review";
    case "approved":
      return "Approved";
    case "unverified":
      return "Unverified (no totals)";
    default:
      return status;
  }
}

/* The run status vocabulary. The server owns the authoritative strings; this
 * union documents the known set while still allowing forward-compatible `string`
 * comparisons at the call sites (no server contract is frozen here). */
export type RunStatus =
  | "pending"
  | "running"
  | "failed"
  | "awaiting_review"
  | "approved"
  | "passed"
  | "passed_with_blocked"
  | "unverified"
  | "skipped"
  | (string & {});

/** A run's review/action gating, in one place so the checks are not duplicated. */
export interface RunGateState {
  status: RunStatus;
  stage?: string;
  rework?: unknown;
}

export const isRunning = (status: RunStatus): boolean => status === "running";
export const isFailed = (status: RunStatus): boolean => status === "failed";
export const isAwaitingReview = (status: RunStatus): boolean => status === "awaiting_review";
export const isApproved = (status: RunStatus): boolean => status === "approved";

/** Approve is offered only when awaiting review AND no in-flight rework consumer exists. */
export const canApprove = (state: RunGateState): boolean =>
  state.status === "awaiting_review" && !state.rework;
/** Retry resumes a failed run from its interrupted stage. */
export const canRetry = (state: RunGateState): boolean => state.status === "failed";
/** Stop is offered only while the agent is running. */
export const canStop = (state: RunGateState): boolean => state.status === "running";
/** A human message can be injected into a failed run's phase1..phase4. */
export const canMessage = (state: RunGateState): boolean =>
  state.status === "failed" && ["phase1", "phase2", "phase3", "phase4"].includes(state.stage ?? "");

/* Copy to clipboard. navigator.clipboard needs a secure context (https/
 * localhost); the viewer is plain http on a LAN, so fall back to a hidden
 * textarea + document.execCommand("copy"), which still works there. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok: boolean;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}
