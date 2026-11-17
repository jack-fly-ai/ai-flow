import { apiFetch, downloadBlob, getStoredToken } from "@/lib/api";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  MenuItem,
  Select,
  Tooltip,
  Typography,
} from "@mui/material";
import { LABELS, STAGES, type Stage } from "@/lib/shared";
import { LOG_BG, LOG_FG } from "@/lib/palette";
import { LOG_POLL_INTERVAL_MS, MAX_RENDERED_EVENTS, SSE_MAX_ERRORS } from "@/lib/constants";
/* The structured stream events come from the server-side formatter
 * (type-only import: erased at compile time, no runtime coupling). */
import type { StreamEvent } from "@server/agents/streamFormat";
/* Strip ANSI/OSC escape sequences from streamed log content - the client-side
 * counterpart of src/redact.ts (agent CLIs emit color even headless). The
 * control characters are the point of the pattern, hence the scoped disable. */
// eslint-disable-next-line no-control-regex -- matching ESC/BEL requires the control characters themselves
const ANSI_PATTERNS = [/\x1b\[[0-9;]*[A-Za-z]/g, /\x1b\][^\x07]*\x07/g];

function stripAnsi(text: string): string {
  return ANSI_PATTERNS.reduce((out, pattern) => out.replace(pattern, ""), text);
}

function ToolRow({ event }: { event: Extract<StreamEvent, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const statusColor = event.status === "FAILED" ? "#ff8a80" : event.status ? "#8fd694" : "#e0b05e";
  const statusText = event.status ? ` → ${event.status}${event.ms ? ` (${(event.ms / 1000).toFixed(1)}s)` : ""}` : " → no result yet";
  const toggle = (): void => {
    if (event.input) setOpen((v) => !v);
  };
  return (
    <Box component="div" sx={{ fontSize: 12.5 }}>
      {/* Keyboard-operable disclosure toggle (role/tabIndex/Enter+Space): the
       * tool input is operator-relevant evidence, so it must not be
       * mouse-only. */}
      <Box
        component="div"
        role={event.input ? "button" : undefined}
        tabIndex={event.input ? 0 : undefined}
        aria-expanded={event.input ? open : undefined}
        onClick={toggle}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === "Enter" || keyEvent.key === " ") {
            keyEvent.preventDefault();
            toggle();
          }
        }}
        sx={{
          cursor: event.input ? "pointer" : "default",
          display: "flex",
          gap: 1,
          alignItems: "baseline",
          flexWrap: "wrap",
          borderRadius: 0.5,
          "&:focus-visible": { outline: "1px solid #4f8cc9", outlineOffset: 1 },
        }}
      >
        <Typography component="span" sx={{ color: "#c792ea", fontSize: 12.5, whiteSpace: "nowrap" }}>
          {event.input ? (open ? "▾" : "▸") : "·"} tool: {event.name}
        </Typography>
        <Typography component="span" sx={{ color: "#d5dbe1", fontSize: 12.5, whiteSpace: "pre-wrap", wordBreak: "break-all", flex: 1, minWidth: 0 }}>
          {event.summary}
          <Typography component="span" sx={{ color: statusColor }}>{statusText}</Typography>
        </Typography>
      </Box>
      {open && event.input ? (
        <Typography component="pre" sx={{ m: 0.5, pl: 3, color: "#aeb8c4", fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {event.input}
        </Typography>
      ) : null}
    </Box>
  );
}

/* Max events rendered: the full list is unbounded for a long phase (hundreds of
 * tool calls); the tail is what a live reader needs, and the full history is in
 * the full-log download. (MAX_RENDERED_EVENTS comes from ../constants.) */

function StreamEventsView({ events }: { events: StreamEvent[] }) {
  const total = events.length;
  const shown = total > MAX_RENDERED_EVENTS ? events.slice(total - MAX_RENDERED_EVENTS) : events;
  return (
    <Box component="div" sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      {total > shown.length ? (
        <Typography sx={{ color: "#7a8699", fontSize: 12 }}>
          … showing the last {shown.length} of {total} events (older history is in the full-log download) …
        </Typography>
      ) : null}
      {shown.map((event, relativeIndex) => {
        /* Absolute index keeps ToolRow's local state bound to its own event
         * when the rendered window slides. */
        const index = total - shown.length + relativeIndex;
        if (event.kind === "step")
          return (
            <Typography key={index} sx={{ color: "#7a8699", fontSize: 12, mt: 1 }}>
              ── step {event.n} ──
            </Typography>
          );
        if (event.kind === "user")
          return (
            <Typography key={index} sx={{ color: "#9ecbff", fontSize: 12.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              [user] {event.text}
            </Typography>
          );
        if (event.kind === "thinking")
          return (
            <Typography key={index} sx={{ color: "#8b93a7", fontSize: 12, fontStyle: "italic", whiteSpace: "pre-wrap", wordBreak: "break-word", borderLeft: "2px solid #333c4d", pl: 1 }}>
              {event.text}
              {event.complete ? "" : " …"}
            </Typography>
          );
        if (event.kind === "assistant")
          return (
            <Typography key={index} sx={{ color: "#d5dbe1", fontSize: 12.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {event.text}
              {event.complete ? "" : " …"}
            </Typography>
          );
        if (event.kind === "tool") return <ToolRow key={index} event={event} />;
        if (event.kind === "turn")
          return (
            <Typography key={index} sx={{ color: "#8fd694", fontSize: 12 }}>
              [turn completed] {event.text}
              {event.tokens ? ` · tokens: ${event.tokens}` : ""}
            </Typography>
          );
        return (
          <Typography key={index} sx={{ color: "#d5dbe1", fontSize: 12 }}>
            {event.text}
          </Typography>
        );
      })}
    </Box>
  );
}

/* Live log view: the current stage's agent output (2s poll, walking back to the
 * newest earlier stage that has a log). The stage selector pins one stage's log.
 * The effect depends on primitive props only, so its timer keeps its cadence
 * instead of being recreated by the parent's 3s detail poll. */
/* Consecutive EventSource errors tolerated before giving up on the stream and
 * falling back to polling. EventSource reconnects on its own after a transient
 * blip (a proxy restart, a brief network drop), so the FIRST error is not a
 * failure — but a persistent error (auth broken, server gone, a proxy that
 * never completes the handshake) must not leave the panel silently stale. */
/* SSE_MAX_ERRORS comes from ../constants. */

export function LiveLogPanel({
  runId,
  stage,
}: {
  runId: string;
  /** The run's current stage (drives the log walk-back). */
  stage: string;
}) {
  const [liveLog, setLiveLog] = useState<{ exists: boolean; content: string; stage: string; truncated: boolean; events?: StreamEvent[] }>({ exists: false, content: "", stage: "", truncated: false });
  const [autoScroll, setAutoScroll] = useState(true);
  const [downloadFailed, setDownloadFailed] = useState(false);
  // null = follow the run's current stage; a stage name pins the view.
  const [pinnedStage, setPinnedStage] = useState<Stage | null>(null);
  /* Set when the SSE stream has persistently failed for a specific
   * (runId, stage): the panel then stays on the polling path (still live, just
   * 2s granularity) for THAT stage instead of an EventSource that reconnects
   * forever without ever showing content. Keyed by runId AND stage so a
   * transient blip on one stage does not permanently downgrade the rest of the
   * run — each new stage re-attempts the stream. A different run also gets a
   * fresh attempt; deriving `sseUnavailable` from both fields (below) makes the
   * reset automatic on run/stage change with no state-in-effect. */
  const [sseFailure, setSseFailure] = useState<{ runId: string; stage: string } | null>(null);
  const sseUnavailable = sseFailure?.runId === runId && sseFailure?.stage === stage;
  const logBoxRef = useRef<HTMLPreElement | null>(null);
  /** One fetch at a time: a slow response never piles up overlapping requests. */
  const liveLogInFlightRef = useRef(false);

  useEffect(() => {
    if (!runId || !stage) return;

    /* Following mode + SSE support: stream the active stage's log in real time
     * (P1). EventSource cannot send a custom header, so the token rides ?token=
     * — the same channel the download links use. When the stage is pinned, the
     * stream has persistently failed, or the browser lacks EventSource, we fall
     * through to the 2s poll below. */
    if (pinnedStage === null && !sseUnavailable && typeof EventSource !== "undefined") {
      const token = getStoredToken();
      const url = `/api/runs/${encodeURIComponent(runId)}/logs/${encodeURIComponent(stage)}/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      const source = new EventSource(url);
      let errors = 0;
      let settled = false;
      source.onmessage = (ev: MessageEvent) => {
        try {
          const body = JSON.parse(ev.data) as { exists: boolean; content: string; truncated?: boolean; events?: StreamEvent[]; stage?: string };
          setLiveLog({
            exists: body.exists,
            stage: (body.stage as Stage) ?? (stage as Stage),
            truncated: Boolean(body.truncated),
            events: body.events,
            content: stripAnsi(body.content),
          });
        } catch {
          // ignore a malformed frame; the next one arrives within a second
        }
      };
      source.onerror = () => {
        if (settled) return;
        errors += 1;
        /* EventSource auto-reconnects after a transient error, so a single
         * error is not actionable. Probe the ordinary API once to classify a
         * persistent failure:
         *  - 401 (apiFetch emits the re-login event itself): the token is
         *    broken — no stream will ever authenticate; fall back at once.
         *  - any other answer: the API is fine, only the stream endpoint is
         *    failing — reconnect a couple of times, then fall back.
         *  - network throw: nothing to classify yet; the error count still
         *    bounds the fallback. */
        void (async () => {
          let unauthorized = false;
          try {
            const probe = await apiFetch(`/api/runs/${encodeURIComponent(runId)}/logs/${encodeURIComponent(stage)}`);
            unauthorized = probe.status === 401;
          } catch {
            // offline or probe failed — fall through to the error-count rule
          }
          if (settled) return;
          if (unauthorized || errors >= SSE_MAX_ERRORS) {
            settled = true;
            source.close();
            setSseFailure({ runId, stage });
          }
        })();
      };
      return () => {
        settled = true;
        source.close();
      };
    }

    // Polling path (pinned stage, or no EventSource support).
    let cancelled = false;
    const load = async () => {
      if (liveLogInFlightRef.current) return;
      liveLogInFlightRef.current = true;
      try {
        /* A picked stage (the selector) wins; otherwise follow the current
         * stage, falling back to the newest earlier stage that has one. */
        const order =
          pinnedStage !== null
            ? [pinnedStage]
            : STAGES.slice(0, STAGES.indexOf(stage as Stage) + 1).reverse();
        for (const s of order) {
          const response = await apiFetch(`/api/runs/${encodeURIComponent(runId)}/logs/${s}`);
          if (!response.ok || cancelled) return;
          const body = (await response.json()) as { exists: boolean; content: string; truncated?: boolean; events?: StreamEvent[] };
          if (!body.exists) continue;
          setLiveLog({
            exists: true,
            stage: s,
            truncated: Boolean(body.truncated),
            events: body.events,
            content: stripAnsi(body.content),
          });
          return;
        }
        setLiveLog({ exists: false, stage: order[0] ?? stage, content: "", truncated: false });
      } catch {
        // keep the last content; the next tick retries
      } finally {
        liveLogInFlightRef.current = false;
      }
    };
    void load();
    // Skip ticks while the tab is hidden (backgrounded page, no live reader).
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, LOG_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId, stage, pinnedStage, sseUnavailable]);

  useEffect(() => {
    if (!autoScroll) return;
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [liveLog, autoScroll]);

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1, flexWrap: "wrap" }}>
        <Typography variant="body2" color="text.secondary">
          Agent activity for <strong>{LABELS[liveLog.stage as Stage] ?? liveLog.stage}</strong>. Auto-refreshes.
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            Stage log:
          </Typography>
          <Select
            size="small"
            value={pinnedStage ?? "following"}
            onChange={(event) => setPinnedStage(event.target.value === "following" ? null : (event.target.value as Stage))}
            sx={{ fontSize: 13, minWidth: 190 }}
          >
            <MenuItem value="following">Following (current stage)</MenuItem>
            {STAGES.map((stage) => (
              <MenuItem key={stage} value={stage}>
                {LABELS[stage as Stage] ?? stage}
              </MenuItem>
            ))}
          </Select>
        </Box>
      </Box>
      {sseUnavailable ? (
        <Alert severity="info" sx={{ mb: 1 }}>
          Live streaming is unavailable for this run (the stream endpoint kept failing). Showing polled updates every 2&nbsp;seconds instead — the log content is the same.
        </Alert>
      ) : null}
      {liveLog.truncated ? (
        <Alert
          severity="info"
          sx={{ mb: 1 }}
          action={
            <Button
              onClick={() => {
                setDownloadFailed(false);
                // A failed download must not become an unhandled rejection.
                void downloadBlob(`/api/runs/${encodeURIComponent(runId)}/full-log`, "full-log.txt").catch(() => setDownloadFailed(true));
              }}
              size="small"
              variant="outlined"
            >
              Download complete log
            </Button>
          }
        >
          This stage&apos;s log exceeds 256&nbsp;KB; only the most recent portion is shown. Download the complete run log (all stages) for the full output.
        </Alert>
      ) : null}
      {downloadFailed ? (
        <Alert severity="error" sx={{ mb: 1 }}>
          The complete-log download failed. Retry the download, or read the run&apos;s log files directly under <code>.ai-flow/runs/&lt;id&gt;/logs/</code>.
        </Alert>
      ) : null}
      <Box sx={{ position: "relative" }}>
        <Box
          component="pre"
          ref={logBoxRef}
          role="log"
          aria-live="polite"
          onWheel={(event) => {
            /* User intent: any upward wheel movement stops
             * following immediately — content refreshes must
             * never fight the user's scroll. */
            if (event.deltaY < 0) setAutoScroll(false);
          }}
          onScroll={(event) => {
            /* Pin/unpin by position, whatever input caused the scroll
             * (wheel, scrollbar drag, keyboard): leave the bottom → stop
             * following and hold the view; return to the bottom → resume. */
            const box = event.currentTarget;
            const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
            if (autoScroll && !atBottom) setAutoScroll(false);
            else if (!autoScroll && atBottom) setAutoScroll(true);
          }}
          sx={{
            bgcolor: LOG_BG,
            color: LOG_FG,
            p: 1.5,
            borderRadius: 1,
            overflow: "auto",
            maxHeight: "60vh",
            m: 0,
            fontSize: 12.5,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {liveLog.exists ? (
            liveLog.events && liveLog.events.length > 0 ? (
              <StreamEventsView events={liveLog.events} />
            ) : (
              liveLog.content
            )
          ) : (
            "No log output yet for this stage."
          )}
        </Box>
        {!autoScroll ? (
          <Tooltip title="Resume following the newest output">
            <Button
              variant="contained"
              size="small"
              onClick={() => {
                setAutoScroll(true);
                const box = logBoxRef.current;
                if (box) box.scrollTop = box.scrollHeight;
              }}
              sx={{ position: "absolute", bottom: 12, right: 16 }}
            >
              ↓ Follow
            </Button>
          </Tooltip>
        ) : null}
      </Box>
    </Box>
  );
}
