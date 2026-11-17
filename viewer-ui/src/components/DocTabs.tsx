import {
  Box,
  Button,
  CircularProgress,
  Divider,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LiveLogPanel } from "@/components/LiveLogPanel";

/* TicketForum pulls in the JSON viewer + markdown renderer; load it on demand
 * (only when the Ticket tab is opened) so the initial bundle stays lean. */
const TicketForum = lazy(() => import("@/pages/TicketForum").then((m) => ({ default: m.TicketForum })));
import { DOC_STAGE, DOC_TABS, statusColor, type RunDetail } from "@/lib/shared";

/* The stage that produced the currently open document. When a stage (or any of its
 * sibling documents) is selected, every document it produced is marked as the
 * active group — making the 1:N stage→artifact relationship explicit rather than
 * hiding it behind a single representative doc. */
const activeStage = (tab: string) => DOC_STAGE[tab];

/* A neutral document glyph for tabs that are not backed by a pipeline stage
 * (Live log, Test report, Test cases, Handoff, Clarifications). Keeps every tab
 * aligned at the same visual level as the stage-backed status dots. Inline SVG
 * avoids pulling in @mui/icons-material. */
const DOC_ICON = {
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function DocGlyph() {
  return (
    <svg {...DOC_ICON} aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}
import { renderMarkdown } from "@/lib/markdown";
import type { Theme } from "@mui/material/styles";

/* The document tabs widget: tab strip + Copy, plus tab content (live log,
 * deliverables, ticket forum, markdown docs). The run's action buttons live in the
 * RunHeader now, so this panel stays focused on reading. Content is wrapped in an
 * ErrorBoundary so one bad document degrades locally, not white-screening. */
export function DocTabs({
  tab,
  detail,
  selected,
  onTabChange,
  onCopyText,
}: {
  tab: string;
  detail: RunDetail;
  selected: string;
  onTabChange: (tab: string) => void;
  onCopyText: (text: string, successText: string) => void;
}) {
  const currentDoc = detail.docs[tab];
  const deliverablesFiles = detail.docs.deliverables?.files;

  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        p: 2,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, mb: 1, flexShrink: 0, flexWrap: "wrap" }}>
        <Tabs
          value={tab}
          onChange={(_, value: string) => onTabChange(value)}
          sx={{ minHeight: 36, "& .MuiTab-root": { minHeight: 36, py: 0, textTransform: "none" } }}
        >
          {Object.entries(DOC_TABS).map(([key, label]) => {
            /* A status dot on stage-backed tabs mirrors the timeline's phase status,
             * so a failed/in-flight phase is visible from the document bar too. Docs
             * that belong to the open document's producing stage form the "active
             * group" and are marked with a primary ring + bold (a stage yields
             * several artifacts, not just the one opened). */
            const docStage = DOC_STAGE[key];
            const stageStatus = docStage ? detail.state.stages[docStage]?.status : undefined;
            const inActiveStage = docStage != null && docStage === activeStage(tab);
            return (
              <Tab
                key={key}
                value={key}
                label={
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, whiteSpace: "nowrap" }}>
                    {stageStatus ? (
                      <Box
                        component="span"
                        sx={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          flexShrink: 0,
                          bgcolor:
                            statusColor(stageStatus) === "default" ? "text.disabled" : `${statusColor(stageStatus)}.main`,
                          ...(inActiveStage ? { boxShadow: (theme) => `0 0 0 2px ${theme.palette.primary.main}55` } : null),
                        }}
                      />
                    ) : (
                      <Box component="span" sx={{ color: "text.disabled", display: "flex", alignItems: "center", flexShrink: 0 }}>
                        <DocGlyph />
                      </Box>
                    )}
                    <Box component="span" sx={{ fontWeight: inActiveStage ? 700 : 400 }}>
                      {label}
                    </Box>
                  </Box>
                }
              />
            );
          })}
        </Tabs>
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0, alignItems: "center" }}>
          {tab !== "liveLog" ? (
            <Button
              variant="outlined"
              size="small"
              onClick={() => {
                const text =
                  tab === "deliverables"
                    ? (deliverablesFiles ?? []).map((file) => `${file.name}\n${file.content}`).join("\n\n")
                    : currentDoc?.markdown ?? "";
                onCopyText(text, tab === "deliverables" ? "All deliverables copied" : "Content copied to clipboard");
              }}
            >
              Copy
            </Button>
          ) : null}
        </Stack>
      </Box>
      <Divider sx={{ mb: 2, flexShrink: 0 }} />
      <ErrorBoundary>
        <Box sx={{ overflow: "auto", flex: 1, minHeight: 0 }}>
          {tab === "liveLog" ? (
            <LiveLogPanel runId={selected} stage={detail.state.stage} />
          ) : tab === "deliverables" ? (
            deliverablesFiles?.length ? (
              <Stack spacing={3}>
                {deliverablesFiles.map((file) => (
                  <Box key={file.name}>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1.5,
                        mb: 0.5,
                        width: "fit-content",
                      }}
                    >
                      <Typography variant="subtitle2" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
                        {file.name}
                      </Typography>
                      <Button
                        size="small"
                        variant="outlined"
                        sx={{ flexShrink: 0 }}
                        onClick={() => onCopyText(file.content, `${file.name} copied`)}
                      >
                        Copy this file
                      </Button>
                    </Box>
                    <Box
                      component="pre"
                      sx={{
                        bgcolor: (theme: Theme) => theme.palette.surface,
                        p: 1.5,
                        borderRadius: 1,
                        overflow: "auto",
                        maxHeight: "40vh",
                        m: 0,
                        fontSize: 12.5,
                        lineHeight: 1.5,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {file.content}
                    </Box>
                  </Box>
                ))}
              </Stack>
            ) : (
              <Typography color="text.secondary">Deliverables not ready yet</Typography>
            )
          ) : tab === "ticket" ? (
            currentDoc?.ready ? (
              <Suspense fallback={<CircularProgress size={20} />}>
                <TicketForum markdown={currentDoc.markdown ?? ""} />
              </Suspense>
            ) : (
              <Typography color="text.secondary">
                Ticket not fetched yet — phase 1 retrieves it from the github-mcp MCP and caches it here.
              </Typography>
            )
          ) : currentDoc?.ready ? (
            <Box
              className="markdown"
              sx={{
                "& h1,& h2,& h3": { mt: 1.5, mb: 1 },
                "& p": { my: 1 },
                "& pre": { bgcolor: (theme: Theme) => theme.palette.commentBg, p: 1.5, overflow: "auto", borderRadius: 1 },
                "& ul": { pl: 2.5 },
              }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(currentDoc.markdown ?? "") }}
            />
          ) : (
            <Typography color="text.secondary">Not ready yet</Typography>
          )}
        </Box>
      </ErrorBoundary>
    </Box>
  );
}
