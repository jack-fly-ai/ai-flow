import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  CssBaseline,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  GlobalStyles,
  IconButton,
  ThemeProvider,
  Toolbar,
  Typography,
} from "@mui/material";
import { IssueHistoryPanel } from "@/pages/IssueHistory";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RunList } from "@/components/RunList";
import { LoginGate } from "@/components/LoginGate";
import { RunDetailView } from "@/components/RunDetailView";
import {
  ApproveDialog,
  DeleteDialog,
  MessageDialog,
  RejectDialog,
  RetryDialog,
  StopDialog,
} from "@/components/ActionDialogs";
import { copyToClipboard, canApprove, canMessage, canRetry, canStop } from "@/lib/shared";
import { useRuns, useRunDetail } from "@/lib/queries";
import { useSession } from "@/hooks/useSession";
import { useRunActions } from "@/hooks/useRunActions";
import { buildTheme, scrollbarStyles, type ColorMode } from "@/lib/theme";
import { TOAST_AUTO_DISMISS_MS } from "@/lib/constants";

/* MCP management is operator-only and rarely opened; load it on demand. */
const McpPanel = lazy(() => import("@/pages/McpPanel").then((m) => ({ default: m.McpPanel })));

const COLOR_MODE_STORAGE_KEY = "ai-flow-color-mode";

function getInitialColorMode(): ColorMode {
  try {
    const stored = localStorage.getItem(COLOR_MODE_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* storage may be blocked (private mode); fall through to system/default */
  }
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  /* Developer tool: default to the dark IDE look. */
  return "dark";
}

/* Sun in light mode (tap → go dark), crescent in dark mode (tap → go light). */
function ThemeModeIcon({ mode }: { mode: ColorMode }) {
  return mode === "dark" ? (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z" />
    </svg>
  ) : (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  );
}

export default function App() {
  const { session, sessionChecked, login, loginBusy, loginError } = useSession();

  /* Color mode drives the whole theme (persisted, defaults to dark, honors the
   * OS preference on first visit). The theme object is rebuilt only when mode
   * flips, so the polling timers below keep their cadence. */
  const [mode, setMode] = useState<ColorMode>(getInitialColorMode);
  const theme = useMemo(() => buildTheme(mode), [mode]);
  const toggleColorMode = useCallback(() => {
    setMode((prev) => {
      const next: ColorMode = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(COLOR_MODE_STORAGE_KEY, next);
      } catch {
        /* ignore persistence failures; the flip still applies for this session */
      }
      return next;
    });
  }, []);

  /* Server state now lives in the query cache: the runs list and the selected
   * run's detail. `enabled` ties polling to a live session (the login gate), and
   * Query's dedup/cancel model replaces the old seqRef + in-flight guards. */
  const [selected, setSelected] = useState(() => new URLSearchParams(location.search).get("run"));
  const runsQuery = useRuns(!!session);
  const detailQuery = useRunDetail(selected, !!session);
  /* Stabilize the array identity so callbacks that read it (e.g. deleteTask's
   * neighbor lookup) don't re-create on every poll tick. */
  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data]);
  const detail = detailQuery.data ?? null;
  const detailError = detailQuery.error instanceof Error ? detailQuery.error.message : null;
  const [tab, setTab] = useState("liveLog");
  /* Three persistent main-area views, switched from the AppBar. The issue list
   * is the default (and the only place to start a run); "runs" is also entered
   * automatically when a run is opened (deep link, View run). "mcp" is the
   * operator-only config view. Only one is on screen at a time. */
  const [view, setView] = useState<"issues" | "runs" | "mcp">(() =>
    new URLSearchParams(location.search).has("run") ? "runs" : "issues",
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const selectRun = useCallback((id: string) => {
    setSelected(id);
    setView("runs");
    history.replaceState(null, "", `?run=${encodeURIComponent(id)}`);
  }, []);

  /* Back to the default view: the issue list is the ONLY thing on screen. */
  const showIssueList = useCallback(() => {
    setSelected(null);
    setView("issues");
    history.replaceState(null, "", location.pathname);
  }, []);

  /* After deleting the open run with no neighbors left, clear the selection but
   * stay on the runs view (the hook handles jumping to a surviving neighbor). */
  const clearSelection = useCallback(() => {
    setSelected(null);
    history.replaceState(null, "", location.pathname);
  }, []);

  const {
    startingIssue,
    approveAnswer,
    setApproveAnswer,
    rejectStage,
    setRejectStage,
    rejectComment,
    setRejectComment,
    messageComment,
    setMessageComment,
    deleteTarget,
    deleteRunSummary,
    failedStageLabel,
    retryAction,
    approveAction,
    rejectAction,
    stopAction,
    messageAction,
    deleteAction,
    openApprove,
    openReject,
    openMessage,
    openDeleteDialog,
    startFromIssue,
    retryTask,
    approveTask,
    rejectTask,
    stopTask,
    messageTask,
    deleteTask,
  } = useRunActions({ selected, detail, runs, selectRun, clearSelection, notify: setToast });

  /* Default the tab only when switching runs — never on the polling refresh,
   * which must not fight the user's tab choice. */
  const loadedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) {
      loadedForRef.current = null;
      return;
    }
    if (detail && loadedForRef.current !== selected) {
      loadedForRef.current = selected;
      let initial: string;
      if (detail.state.status === "running") {
        initial = "liveLog";
      } else if (detail.state.status === "awaiting_review" && detail.state.awaiting?.kind !== "gate4") {
        /* A clarification or escalation is what blocks the run — land on the
         * Clarifications tab so the question is visible immediately, not buried
         * under the default Handoff tab. */
        initial = "clarifications";
      } else {
        initial = "handoff";
      }
      setTab(initial);
    }
  }, [selected, detail]);

  /* Power-user review shortcuts. With a run open in the detail view and no text
   * field or modal dialog focused, letter keys drive the review loop: a=approve,
   * r=reject, s=stop, x=retry, m=message. Matches how a reviewer works through a
   * queue without leaving the keyboard (the buttons carry the same hints). */
  useEffect(() => {
    if (view !== "runs" || !selected || !detail) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      /* Any open modal (MUI Dialog sets role="dialog") has focus, so the keystroke
       * would already be landing inside it — never double-trigger from here. */
      if (document.querySelector('[role="dialog"]')) return;
      switch (event.key.toLowerCase()) {
        case "a":
          if (canApprove(detail.state)) {
            event.preventDefault();
            openApprove();
          }
          break;
        case "r":
          if (canApprove(detail.state)) {
            event.preventDefault();
            openReject();
          }
          break;
        case "s":
          if (canStop(detail.state)) {
            event.preventDefault();
            stopAction.openDialog();
          }
          break;
        case "x":
          if (canRetry(detail.state)) {
            event.preventDefault();
            retryAction.openDialog();
          }
          break;
        case "m":
          if (canMessage(detail.state)) {
            event.preventDefault();
            openMessage();
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, selected, detail, openApprove, openReject, stopAction, retryAction, openMessage]);

  /* Surface a fetch failure once (not on every poll tick) as a toast. */
  const lastErrorKey = useRef<string | null>(null);
  useEffect(() => {
    const err = runsQuery.error ?? detailQuery.error;
    if (!err) {
      lastErrorKey.current = null;
      return;
    }
    const text = err instanceof Error ? err.message : String(err);
    if (lastErrorKey.current === text) return;
    lastErrorKey.current = text;
    setToast({ kind: "error", text });
  }, [runsQuery.error, detailQuery.error]);

  // Toasts are dismissible and also disappear on their own after a while.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const copyText = useCallback((text: string, successText: string) => {
    void copyToClipboard(text).then((ok) => {
      setToast(ok
        ? { kind: "success", text: successText }
        : { kind: "error", text: "Copy failed — select the text and press Ctrl+C" });
    });
  }, []);

  const totalDuration = useMemo(() => {
    if (!detail) return "";
    const stages = Object.values(detail.state.stages);
    const start = stages.map((stage) => stage.startedAt).filter(Boolean).sort()[0];
    const end = stages.map((stage) => stage.finishedAt).filter(Boolean).sort().at(-1);
    if (!start || !end) return "";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (!(ms > 0)) return "";
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
  }, [detail]);

  /* Login gate: the viewer is protected and the stored token is missing/unaccepted.
   * Without a session nothing else renders — no run list, no actions, no operator surface. */
  if (sessionChecked && !session) {
    return <LoginGate busy={loginBusy} error={loginError} onSubmit={login} />;
  }

  const listState: "loading" | "ready" | "error" = runsQuery.isLoading
    ? "loading"
    : runsQuery.isError
      ? "error"
      : "ready";

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <GlobalStyles styles={scrollbarStyles} />
      <Box sx={{ display: "flex", flexDirection: "column", height: "100vh", bgcolor: "background.default" }}>
      <AppBar
        position="static"
        elevation={0}
        color="inherit"
        sx={{ borderBottom: 2, borderColor: "primary.main", flexShrink: 0, bgcolor: "background.paper" }}
      >
        <Toolbar sx={{ gap: 2, minHeight: 56 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: "flex", alignItems: "baseline", gap: 1, minWidth: 0 }}>
              <Typography variant="h6" component="h1" sx={{ color: "primary.main", fontWeight: 700, whiteSpace: "nowrap" }}>
                ai-flow
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                noWrap
                sx={{ overflow: "hidden", textOverflow: "ellipsis" }}
              >
                Agent task runner — watchdog, review &amp; approval console
              </Typography>
            </Box>
          </Box>
          {/* Three explicit view buttons (one is active). The issue list is the
              default and the only place to start a run; MCP is operator-only —
              a user identity never edits the agent's MCP config (hard rule). */}
          <Button
            variant={view === "issues" ? "contained" : "outlined"}
            size="small"
            sx={{ fontWeight: 600, flexShrink: 0 }}
            onClick={showIssueList}
          >
            Issue list
          </Button>
          <Button
            variant={view === "runs" ? "contained" : "outlined"}
            size="small"
            sx={{ fontWeight: 600, flexShrink: 0 }}
            onClick={() => setView("runs")}
          >
            Runs ({runs.length})
          </Button>
          {session?.authEnabled ? (
            <Chip
              size="small"
              variant="outlined"
              color={session.role === "operator" ? "primary" : "default"}
              label={`${session.tenant} · ${session.role}`}
              sx={{ fontWeight: 600, flexShrink: 0 }}
            />
          ) : null}
          {session?.role === "operator" ? (
            <Button
              variant={view === "mcp" ? "contained" : "outlined"}
              size="small"
              sx={{ fontWeight: 600, flexShrink: 0 }}
              onClick={() => setView("mcp")}
            >
              Manage MCP
            </Button>
          ) : null}
          <IconButton
            aria-label={mode === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={toggleColorMode}
            size="small"
            sx={{ flexShrink: 0 }}
          >
            <ThemeModeIcon mode={mode} />
          </IconButton>
          <IconButton
            aria-label="Keyboard shortcuts and review workflow"
            onClick={() => setHelpOpen(true)}
            size="small"
            sx={{ flexShrink: 0 }}
          >
            <Box component="span" sx={{ fontSize: 18, fontWeight: 700, lineHeight: 1 }}>
              ?
            </Box>
          </IconButton>
        </Toolbar>
      </AppBar>

      <ErrorBoundary>
        <Box sx={{ display: "flex", flex: 1, minHeight: 0, width: "100%" }}>
          {/* Default view shows the issue list ONLY: no run list beside it. */}
          {view === "runs" ? (
            <RunList
              runs={runs}
              selectedId={selected}
              loading={listState === "loading" && runs.length === 0}
              error={listState === "error"}
              onSelect={selectRun}
              onDelete={openDeleteDialog}
            />
          ) : null}

          <Box component="main" sx={{ flex: 1, minWidth: 0, p: 2, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            {toast ? (
              <Alert severity={toast.kind} sx={{ mb: 2 }} onClose={() => setToast(null)}>
                {toast.text}
              </Alert>
            ) : null}

            {/* Keep mounted so filter/page/expanded survive a view switch. */}
            <Box
              sx={{
                display: view === "issues" ? "flex" : "none",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
              }}
            >
              <IssueHistoryPanel
                runs={runs}
                visible={view === "issues"}
                startingIssue={startingIssue}
                onStartIssue={startFromIssue}
                onOpenRun={selectRun}
              />
            </Box>

            {/* Keep mounted so an in-progress edit survives a view switch. */}
            <Box
              sx={{
                display: view === "mcp" ? "flex" : "none",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
              }}
            >
              {session?.role === "operator" ? (
                <Suspense fallback={null}>
                  <McpPanel visible={view === "mcp"} />
                </Suspense>
              ) : null}
            </Box>

            {view === "runs" && !selected && runs.length === 0 ? (
              <Typography color="text.secondary">No runs yet. Start one from the Issue list.</Typography>
            ) : null}

            {view === "runs" && !selected && runs.length > 0 ? (
              <Typography color="text.secondary">Select a run from the list on the left.</Typography>
            ) : null}

            {view === "runs" && selected && !detail ? (
              <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, p: 1 }}>
                <CircularProgress size={20} />
                <Typography color="text.secondary">
                  {detailError ? detailError : `Loading ${selected}…`}
                </Typography>
              </Box>
            ) : null}

            {view === "runs" && selected && detail ? (
              <RunDetailView
                detail={detail}
                selected={selected}
                tab={tab}
                totalDuration={totalDuration}
                stopping={stopAction.busy}
                onTabChange={setTab}
                onCopyText={copyText}
                onOpenStop={() => stopAction.openDialog()}
                onOpenRetry={() => retryAction.openDialog()}
                onOpenMessage={() => openMessage()}
                onOpenDelete={() => openDeleteDialog(selected)}
                onOpenApprove={() => openApprove()}
                onOpenReject={() => openReject()}
              />
            ) : null}
          </Box>
        </Box>
      </ErrorBoundary>

      <RetryDialog
        open={retryAction.open}
        busy={retryAction.busy}
        error={retryAction.error}
        runId={selected}
        stageLabel={failedStageLabel}
        onClose={() => retryAction.close()}
        onConfirm={() => void retryTask()}
      />

      <ApproveDialog
        open={approveAction.open}
        busy={approveAction.busy}
        error={approveAction.error}
        awaitingKind={detail?.state.awaiting?.kind ?? null}
        runId={selected}
        answer={approveAnswer}
        onAnswerChange={setApproveAnswer}
        onClose={() => approveAction.close()}
        onConfirm={() => void approveTask()}
      />

      <RejectDialog
        open={rejectAction.open}
        busy={rejectAction.busy}
        error={rejectAction.error}
        stage={rejectStage}
        comment={rejectComment}
        onStageChange={setRejectStage}
        onCommentChange={setRejectComment}
        onClose={() => rejectAction.close()}
        onConfirm={() => void rejectTask()}
      />

      <StopDialog
        open={stopAction.open}
        busy={stopAction.busy}
        runId={selected}
        onClose={() => stopAction.close()}
        onConfirm={() => void stopTask()}
      />

      <DeleteDialog
        open={deleteAction.open}
        busy={deleteAction.busy}
        error={deleteAction.error}
        target={deleteTarget}
        running={deleteRunSummary?.status === "running"}
        onClose={() => deleteAction.close()}
        onConfirm={() => void deleteTask()}
      />

      <MessageDialog
        open={messageAction.open}
        busy={messageAction.busy}
        error={messageAction.error}
        runId={selected}
        stageLabel={failedStageLabel}
        comment={messageComment}
        onCommentChange={setMessageComment}
        onClose={() => messageAction.close()}
        onConfirm={() => void messageTask()}
      />

      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Keyboard shortcuts &amp; review workflow</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            With a run selected (runs view) and no text field or dialog focused:
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {[
              ["j / k", "Move to next / previous run in the queue"],
              ["a", "Approve (when awaiting review)"],
              ["r", "Reject / send back for rework"],
              ["s", "Stop a running run"],
              ["x", "Retry a failed run"],
              ["m", "Message the agent (failed run)"],
              ["Esc", "Close any dialog"],
            ].map(([key, desc]) => (
              <li key={key}>
                <Typography variant="body2" component="span">
                  <Box
                    component="kbd"
                    sx={{ fontFamily: "monospace", bgcolor: "action.hover", px: 0.75, borderRadius: 0.5, mr: 1 }}
                  >
                    {key}
                  </Box>
                  {desc}
                </Typography>
              </li>
            ))}
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            The run list is a review queue: awaiting-review and failed runs sort to the top and you can filter by id or status.
            A run that blocks on a clarification or escalation opens straight on its Clarifications tab.
          </Typography>
        </DialogContent>
      </Dialog>
    </Box>
    </ThemeProvider>
  );
}
