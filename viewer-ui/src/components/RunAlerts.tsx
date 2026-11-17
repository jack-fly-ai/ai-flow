import { Alert, Box } from "@mui/material";
import { LABELS, type RunDetail, type Stage } from "@/lib/shared";

/**
 * The run-level alerts: the generic-pack scope warning, the stage failure, the
 * gate-4 sync failure, and the awaiting-review / clarification / escalation
 * notices. Rendered beneath the RunHeader so they stay in view beside the action
 * bar instead of being buried in the document panel.
 */
export function RunAlerts({ detail }: { detail: RunDetail }) {
  const state = detail.state;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1, flexShrink: 0 }}>
      {detail.genericPack ? (
        <Alert severity="warning">
          Pack <strong>{state.taskdev?.pack ?? "(none recorded)"}</strong> has no dedicated module adapter: no scope
          guard and no automatic pack check were applied to this run. The gate-4 audit is the ONLY backstop that the
          change is limited to what it should be — review the full diff at gate 4 with extra care.
        </Alert>
      ) : null}
      {state.error ? (
        <Alert severity="error">Failed at {LABELS[state.stage as Stage] ?? state.stage}: {state.error}</Alert>
      ) : null}
      {state.gate4Sync?.status === "failed" ? (
        <Alert severity="warning">
          Gate 4 was approved, but the task-progress gate-4 record could not be written
          {state.gate4Sync.error ? ` (${state.gate4Sync.error})` : ""}. The run is approved in ai-flow; if your
          submission tooling reads task-progress gate 4, record it there manually or re-approve after fixing the cause.
        </Alert>
      ) : null}
      {state.awaiting ? (
        state.awaiting.kind === "gate4" ? (
          <Alert severity="info">
            Awaiting gate 4 approval. Approve to record the gate as passed and start the patch download (the package is
            also in the Download menu), or Reject to send it back for rework.
          </Alert>
        ) : (
          <Alert severity="warning">
            {state.awaiting.kind === "clarification" ? "Clarification needed" : "Escalation"}{" "}
            {state.awaiting.code ?? ""} — see the Clarifications tab and answer via Approve.
          </Alert>
        )
      ) : null}
    </Box>
  );
}
