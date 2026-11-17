import { useState } from "react";
import { Box, Button, Chip, Divider, Menu, MenuItem, Stack, Typography } from "@mui/material";
import { downloadBlob } from "@/lib/api";
import { canMessage, formatShortDateTime, statusColor, statusLabel, type RunDetail } from "@/lib/shared";
import { ActionButtons } from "@/components/ActionDialogs";

/* A single metadata field: a muted label and a bold value, separated by a thin
 * vertical rule when rendered in a row. */
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.5, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
        {value}
      </Typography>
    </Box>
  );
}

/**
 * Run summary header: identity (id), live status, the test verdict, key metadata
 * (workspace / base commit / started / updated / duration), and the full action
 * surface (Download menu + Stop/Retry/Message/Delete/Approve/Reject). Keeping the
 * controls in a persistent bar above the scrolling content follows the dashboard
 * convention — the reviewer acts without losing their place in the documents.
 */
export function RunHeader({
  detail,
  selected,
  totalDuration,
  stopping,
  onOpenStop,
  onOpenRetry,
  onOpenMessage,
  onOpenDelete,
  onOpenApprove,
  onOpenReject,
}: {
  detail: RunDetail;
  selected: string;
  totalDuration: string;
  stopping: boolean;
  onOpenStop: () => void;
  onOpenRetry: () => void;
  onOpenMessage: () => void;
  onOpenDelete: () => void;
  onOpenApprove: () => void;
  onOpenReject: () => void;
}) {
  const state = detail.state;
  const status = state.status;
  const testVerdict = state.test?.verdict;
  const hasPackage = Boolean(state.artifacts?.package);
  const hasPatch = Boolean(state.artifacts?.patch);
  /* One Download button, a menu of the deliverables that actually exist. Both are
   * offered when ready; a failed download must not become an unhandled rejection.
   * The package tarball is tenant-bound (a cross-tenant read is refused), the
   * patch lives inside the run dir (refused by ownership on the run record). */
  const [downloadAnchor, setDownloadAnchor] = useState<null | HTMLElement>(null);
  const downloadPackage = () => {
    void downloadBlob(`/api/runs/${encodeURIComponent(selected)}/package`).catch((err: unknown) => {
      console.error("package download failed", err);
    });
  };
  const downloadPatch = () => {
    void downloadBlob(`/api/runs/${encodeURIComponent(selected)}/patch`).catch((err: unknown) => {
      console.error("patch download failed", err);
    });
  };
  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        p: 2,
        flexShrink: 0,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 2, flexWrap: "wrap" }}>
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
            <Typography variant="h6" component="h2" sx={{ fontWeight: 700, lineHeight: 1.2, m: 0 }}>
              {state.id}
            </Typography>
            <Chip size="small" label={statusLabel(status)} color={statusColor(status)} />
            {testVerdict ? (
              <Chip
                size="small"
                variant="outlined"
                label={`Tests: ${statusLabel(testVerdict)}`}
                color={statusColor(testVerdict)}
              />
            ) : null}
          </Box>
          <Stack
            direction="row"
            spacing={2}
            sx={{ mt: 1, flexWrap: "wrap", rowGap: 0.5, alignItems: "center" }}
            divider={<Divider orientation="vertical" flexItem />}
          >
            {state.taskdev?.workspace ? <Meta label="Workspace" value={state.taskdev.workspace} /> : null}
            {state.model ? <Meta label="Model" value={state.model} /> : null}
            {state.baseCommit ? <Meta label="Base" value={state.baseCommit.slice(0, 8)} /> : null}
            {state.startedAt ? <Meta label="Started" value={formatShortDateTime(state.startedAt)} /> : null}
            {state.updatedAt ? <Meta label="Updated" value={formatShortDateTime(state.updatedAt)} /> : null}
            {totalDuration ? <Meta label="Duration" value={totalDuration} /> : null}
          </Stack>
        </Box>
        <Stack
          direction="row"
          spacing={1}
          sx={{ flexShrink: 0, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}
        >
          {hasPackage || hasPatch ? (
            <>
              <Button
                variant="outlined"
                size="small"
                onClick={(event) => setDownloadAnchor(event.currentTarget)}
                endIcon={<span aria-hidden style={{ fontSize: 12, lineHeight: 1 }}>▾</span>}
              >
                Download
              </Button>
              <Menu anchorEl={downloadAnchor} open={Boolean(downloadAnchor)} onClose={() => setDownloadAnchor(null)}>
                {hasPackage ? (
                  <MenuItem
                    onClick={() => {
                      setDownloadAnchor(null);
                      downloadPackage();
                    }}
                  >
                    Package (tarball)
                  </MenuItem>
                ) : null}
                {hasPatch ? (
                  <MenuItem
                    onClick={() => {
                      setDownloadAnchor(null);
                      downloadPatch();
                    }}
                  >
                    Patch (CHANGES)
                  </MenuItem>
                ) : null}
              </Menu>
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Deliverables not ready
            </Typography>
          )}
          <ActionButtons
            status={status}
            stopping={stopping}
            messageAvailable={canMessage(state)}
            onStop={onOpenStop}
            onRetry={onOpenRetry}
            onMessage={onOpenMessage}
            onDelete={onOpenDelete}
            onApprove={onOpenApprove}
            onReject={onOpenReject}
          />
        </Stack>
      </Box>
    </Box>
  );
}
