import { Box } from "@mui/material";
import { RunHeader } from "@/components/RunHeader";
import { RunAlerts } from "@/components/RunAlerts";
import { StagePanel } from "@/components/StagePanel";
import { DocTabs } from "@/components/DocTabs";
import type { RunDetail } from "@/lib/shared";

/* The selected run's detail. A persistent RunHeader (identity, status, metadata,
 * and the action surface) sits above the RunAlerts, then a two-column body: the
 * StagePanel timeline (left, a fixed 300px rail) and the DocTabs (right, the
 * scrolling document area). All state (tab, action dialogs) still lives in App and
 * is passed down as props; this component is a pure layout shell. */
export function RunDetailView({
  detail,
  selected,
  tab,
  totalDuration,
  stopping,
  onTabChange,
  onCopyText,
  onOpenStop,
  onOpenRetry,
  onOpenMessage,
  onOpenDelete,
  onOpenApprove,
  onOpenReject,
}: {
  detail: RunDetail;
  selected: string;
  tab: string;
  totalDuration: string;
  stopping: boolean;
  onTabChange: (tab: string) => void;
  onCopyText: (text: string, successText: string) => void;
  onOpenStop: () => void;
  onOpenRetry: () => void;
  onOpenMessage: () => void;
  onOpenDelete: () => void;
  onOpenApprove: () => void;
  onOpenReject: () => void;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        flex: 1,
        minHeight: 0,
        /* Wide screens keep the header/alerts pinned and let the two columns
         * scroll internally. On narrow screens the layout stacks into one column,
         * so let the whole detail scroll naturally instead of fighting for a
         * bounded height. */
        overflowY: { xs: "auto", md: "hidden" },
      }}
    >
      <RunHeader
        detail={detail}
        selected={selected}
        totalDuration={totalDuration}
        stopping={stopping}
        onOpenStop={onOpenStop}
        onOpenRetry={onOpenRetry}
        onOpenMessage={onOpenMessage}
        onOpenDelete={onOpenDelete}
        onOpenApprove={onOpenApprove}
        onOpenReject={onOpenReject}
      />
      <RunAlerts detail={detail} />
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "300px 1fr" },
          /* One bounded row on wide screens (columns scroll inside); natural
           * height rows when stacked so the outer container scrolls instead. */
          gridTemplateRows: { xs: "auto", md: "minmax(0, 1fr)" },
          gap: 2,
          flex: 1,
          minHeight: 0,
        }}
      >
        <StagePanel stages={detail.state.stages} tab={tab} totalDuration={totalDuration} onSelect={onTabChange} />
        <DocTabs tab={tab} detail={detail} selected={selected} onTabChange={onTabChange} onCopyText={onCopyText} />
      </Box>
    </Box>
  );
}
