import { Box, Chip, CircularProgress, List, ListItem, ListItemButton, Typography } from "@mui/material";
import {
  DOC_STAGE,
  DOC_TABS,
  LABELS,
  STAGES,
  STAGE_DOCS,
  STAGE_TAB,
  formatShortDateTime,
  statusColor,
  statusLabel,
  type StageInfo,
} from "@/lib/shared";

/* A 11px inline glyph for a stage's terminal/active status. Pending stages have
 * no glyph (they show their sequence number instead); anything unrecognized also
 * falls back to the number. Inline SVG keeps the bundle free of @mui/icons-material. */
const ICON_PROPS = {
  width: 11,
  height: 11,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 3,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function StageGlyph({ status }: { status: string }) {
  if (status === "running") {
    return <CircularProgress size={11} thickness={5} sx={{ color: "common.white" }} />;
  }
  if (status === "success" || status === "passed") {
    return (
      <svg {...ICON_PROPS} aria-hidden>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg {...ICON_PROPS} aria-hidden>
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    );
  }
  if (status === "awaiting_review") {
    return (
      <svg {...ICON_PROPS} aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }
  return null;
}

/**
 * The six-stage pipeline as a vertical timeline. Each stage is a node on a rail
 * that connects down to the next stage: a status-colored circle carrying either a
 * status glyph (✓ / ✕ / spinner / clock) or, for pending stages, its sequence
 * number. The stage that produced the open document is marked with the primary
 * accent + ring + bold label. Beneath each label are clickable chips for *all* the
 * documents that stage produced (the 1:N stage→artifact relationship), so siblings
 * are reachable directly from the timeline. The primary doc (STAGE_TAB) opens when
 * the label itself is clicked.
 */
export function StagePanel({
  stages,
  tab,
  totalDuration,
  onSelect,
}: {
  stages: Record<string, StageInfo>;
  /** Currently active document tab (marks the matching stage as selected). */
  tab: string;
  totalDuration: string;
  onSelect: (tab: string) => void;
}) {
  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        p: 1,
        alignSelf: "stretch",
        overflow: "auto",
        minHeight: 0,
      }}
    >
      <Typography variant="subtitle2" sx={{ px: 1, py: 0.5 }}>
        Stages
        {totalDuration ? (
          <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
            total {totalDuration}
          </Typography>
        ) : null}
      </Typography>
      <List dense disablePadding>
        {STAGES.map((name, index) => {
          const stageState = stages[name];
          const status = stageState?.status ?? "pending";
          /* Highlight the stage that produced the currently open document — covers
           * sibling docs too (e.g. opening "Handoff" lights up phase2), so the
           * timeline reflects the real 1:N stage→artifact relationship. */
          const active = DOC_STAGE[tab] === name;
          const isLast = index === STAGES.length - 1;
          const passedAt = stageState?.finishedAt ? formatShortDateTime(stageState.finishedAt) : null;
          const docs = STAGE_DOCS[name];
          /* "default" (pending) has no palette *.main — a muted dot until the
           * stage actually runs; the active stage always uses the primary accent. */
          const statusName = statusColor(status);
          const dotColor = active ? "primary.main" : statusName === "default" ? "text.disabled" : `${statusName}.main`;
          const glyph = <StageGlyph status={status} />;
          /* A completed/failed stage tints the connector it leaves behind, so the
           * pipeline reads as progress (green = done, red = broken) instead of a
           * flat grey rail. */
          const connectorColor = status === "passed" ? "success.main" : status === "failed" ? "error.main" : "divider";
          return (
            <ListItem key={name} disablePadding sx={{ alignItems: "stretch" }}>
              <Box sx={{ display: "flex", gap: 1.25, width: "100%", alignItems: "stretch" }}>
                {/* Timeline rail: a status node above a connector to the next stage.
                 * The connector stretches through the doc chips below the label. */}
                <Box
                  sx={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    width: 16,
                    flexShrink: 0,
                    pt: 0.75,
                  }}
                >
                  <Box
                    sx={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      bgcolor: statusName === "default" ? "transparent" : dotColor,
                      border: statusName === "default" ? "1.5px solid" : "none",
                      borderColor: statusName === "default" ? "divider" : "transparent",
                      ...(active ? { boxShadow: (theme) => `0 0 0 3px ${theme.palette.primary.main}33` } : null),
                    }}
                  >
                    {glyph ? (
                      <Box sx={{ color: "common.white", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {glyph}
                      </Box>
                    ) : (
                      <Typography variant="caption" sx={{ fontSize: 9, fontWeight: 700, lineHeight: 1, color: "text.disabled" }}>
                        {index + 1}
                      </Typography>
                    )}
                  </Box>
                  {!isLast ? (
                    <Box sx={{ width: 2, flex: 1, bgcolor: connectorColor, mt: 0.5, minHeight: 12 }} />
                  ) : null}
                </Box>

                {/* Stage label (opens the primary doc) + produced-doc chips. */}
                <Box sx={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column" }}>
                  <ListItemButton
                    disableRipple
                    onClick={() => onSelect(STAGE_TAB[name])}
                    selected={active}
                    sx={{ borderRadius: 1, py: 0.5, px: 1, mx: -1, cursor: "pointer", minHeight: 0 }}
                  >
                    <Box sx={{ minWidth: 0, flex: 1, mr: 1 }}>
                      <Typography variant="body2" noWrap sx={{ fontWeight: active ? 700 : 400, lineHeight: 1.2 }}>
                        {LABELS[name]}
                      </Typography>
                      {passedAt ? (
                        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
                          {passedAt}
                        </Typography>
                      ) : null}
                    </Box>
                    <Chip
                      size="small"
                      label={status === "awaiting_review" ? "Review" : statusLabel(status)}
                      color={statusColor(status)}
                      sx={{ flexShrink: 0 }}
                    />
                  </ListItemButton>
                  {docs.length ? (
                    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, px: 0.5, pb: 0.75, pt: 0.25 }}>
                      {docs.map((doc) => (
                        <Chip
                          key={doc}
                          size="small"
                          label={DOC_TABS[doc] ?? doc}
                          variant={tab === doc ? "filled" : "outlined"}
                          color={tab === doc ? "primary" : "default"}
                          onClick={() => onSelect(doc)}
                          sx={{ height: 20, fontSize: 10.5, "& .MuiChip-label": { px: 0.75 } }}
                        />
                      ))}
                    </Box>
                  ) : null}
                </Box>
              </Box>
            </ListItem>
          );
        })}
      </List>
    </Box>
  );
}
