import { apiFetch } from "@/lib/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Link,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { formatLocalDateTime, statusColor, type IssueEntry, type IssuesView, type RunSummary } from "@/lib/shared";
import { PRIMARY } from "@/lib/palette";

/** Rows per page. The snapshot can hold up to 1000 issues; rendering them all
 *  (each with several MUI Chips) would create thousands of DOM nodes. */
const PAGE_SIZE = 50;

/* Best-effort UI pre-check: corrupted state and exact pgid liveness are
 * server-only. The backend's 409 is authoritative. */
const ACTIVE_RUN_STATUSES = new Set(["running", "awaiting_review", "approved"]);

/** A closed issue must not be startable from the history list: the sync pulls
 *  state=all, so closed tickets are present for reference only. normalizeId
 *  would accept the number and the agent would fetch a closed ticket. */
const STARTABLE_STATE = "open";

/* Small inline SVG glyphs — the project deliberately avoids @mui/icons-material
 * to keep the bundle lean; these match the other panels' line-icon language. */
const GLYPH = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function SearchGlyph() {
  return (
    <svg {...GLYPH} aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </svg>
  );
}

function InfoGlyph() {
  return (
    <svg {...GLYPH} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

function RefreshGlyph() {
  return (
    <svg {...GLYPH} aria-hidden>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

function ChevronGlyph({ expanded }: { expanded: boolean }) {
  return (
    <svg {...GLYPH} aria-hidden style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/**
 * Read-only GitHub issue history, rendered as a PERSISTENT main-area
 * view rather than a modal: it is a browsing surface (filter/scan/compare), not
 * a short transactional action. It is the DEFAULT view and the only thing on
 * screen until the operator switches to the run list; each row still joins the
 * local run summaries so an existing run is visible as a chip/button.
 *
 * The viewer serves a LOCAL snapshot written offline by `ai-flow sync-issues`;
 * it never calls GitHub itself. The banner makes that explicit so nobody
 * mistakes this list for live GitHub state.
 */
export function IssueHistoryPanel({
  runs,
  visible,
  startingIssue,
  onStartIssue,
  onOpenRun,
}: {
  runs: RunSummary[];
  /** True while the issues view is on screen. The panel stays MOUNTED (to keep
   *  filter/page state) but hidden, so it needs this to know when to reload. */
  visible: boolean;
  /** Issue number whose run is launching, or null. Drives the per-row busy state. */
  startingIssue?: number | null;
  onStartIssue: (number: number) => void;
  onOpenRun: (id: string) => void;
}) {
  const [view, setView] = useState<IssuesView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);

  /* The guard must be a PREDICATE, not a boolean: passing `cancelled` by value
   * would freeze it at false and a response arriving after unmount would still
   * write state. Reading the flag after each await keeps the cleanup effective.
   * `silent` leaves the current list on screen while re-reading the local file
   * (used when returning to this view), avoiding a full-page spinner. */
  const load = useCallback(async (isCancelled: () => boolean = () => false, silent = false) => {
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const res = await apiFetch("/api/issues");
      const body = (await res.json()) as IssuesView;
      if (isCancelled()) return;
      setView(body);
      setError("");
    } catch {
      /* A background reload must not blank the rows already on screen: on
       * failure keep the previous snapshot (and its stale banner) visible. */
      if (!isCancelled() && !silent) setError("Could not load the issue snapshot.");
    } finally {
      if (!isCancelled() && !silent) setLoading(false);
    }
  }, []);

  /* ONE load per visibility transition: the panel stays mounted even while
   * hidden (filter/page state survive), so a hidden period must cancel any
   * in-flight request. The first show uses the full spinner; returning to the
   * issues view reloads SILENTLY so the stale banner/rows are refreshed without
   * blanking the list the operator was reading. No request fires while hidden. */
  const shownBefore = useRef(false);
  useEffect(() => {
    if (!visible) {
      shownBefore.current = false;
      return;
    }
    const firstShow = !shownBefore.current;
    shownBefore.current = true;
    let cancelled = false;
    void load(() => cancelled, !firstShow);
    return () => {
      cancelled = true;
    };
  }, [visible, load]);

  const issues = useMemo(() => {
    const all = view?.issues ?? [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (issue) =>
        `#${issue.number}`.includes(needle) ||
        String(issue.number).includes(needle) ||
        issue.title.toLowerCase().includes(needle) ||
        issue.author.toLowerCase().includes(needle) ||
        issue.labels.some((label) => label.toLowerCase().includes(needle)),
    );
  }, [view, filter]);

  /* run ids ARE issue numbers (numeric only), so the local run list can be
   * joined to the snapshot without a new endpoint. */
  const runsByNumber = useMemo(() => {
    const map = new Map<number, RunSummary>();
    for (const run of runs) {
      const n = Number(run.id);
      if (Number.isInteger(n) && n > 0) map.set(n, run);
    }
    return map;
  }, [runs]);

  const pageCount = Math.max(1, Math.ceil(issues.length / PAGE_SIZE));
  /* A filter change shrinks the result set; clamp instead of showing an empty
   * page and reset to page 1 when the user types. */
  const safePage = Math.min(page, pageCount);
  const pageIssues = issues.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const first = issues.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const last = Math.min(safePage * PAGE_SIZE, issues.length);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Header: title + repo on one line, reload beside it. */}
      <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", mb: 1.5, gap: 2, flexShrink: 0 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
            Issue history
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {view?.repo ?? "GitHub issues"} · local snapshot, read-only
          </Typography>
        </Box>
        <Button
          variant="outlined"
          size="small"
          onClick={() => void load()}
          disabled={loading}
          sx={{ flexShrink: 0, textTransform: "none" }}
        >
          <Box component="span" sx={{ display: "inline-flex", mr: 0.75, verticalAlign: "middle" }}>
            <RefreshGlyph />
          </Box>
          Reload snapshot
        </Button>
      </Stack>

      {/* Compact read-only notice — one slim strip instead of a full-width banner. */}
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "flex-start",
          p: 1.25,
          mb: 1.5,
          flexShrink: 0,
          border: 1,
          borderColor: "divider",
          borderRadius: 1,
          bgcolor: "action.hover",
        }}
      >
        <Box sx={{ color: "info.main", display: "flex", pt: 0.15, flexShrink: 0 }}>
          <InfoGlyph />
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.6 }}>
          This is a <strong>point-in-time snapshot</strong> from a local file — read-only: ai-flow never writes to GitHub
          and the viewer makes no request to GitHub. <strong>Reload snapshot</strong> only re-reads that local file; to
          fetch newer issues run <code>ai-flow sync-issues</code> on the server.
        </Typography>
      </Stack>

      {/* Sync status as a single meta line with a state dot, not a second banner. */}
      {view?.syncedAt ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.5, px: 0.5, flexShrink: 0 }}>
          <Box
            sx={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              flexShrink: 0,
              bgcolor: view.stale ? "warning.main" : "success.main",
            }}
          />
          <Typography variant="caption" color="text.secondary">
            Snapshot taken {formatLocalDateTime(view.syncedAt)}
            {view.stale ? " — older than 24h, it may be outdated." : "."}
            {view.truncated ? " The list was truncated at the sync page cap." : ""}
            {view.note ? ` ${view.note}` : ""}
          </Typography>
        </Stack>
      ) : null}

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", py: 6, flex: 1 }}>
          <CircularProgress size={28} />
        </Box>
      ) : error ? (
        <Alert severity="error">{error}</Alert>
      ) : view && !view.ready ? (
        <Alert severity="warning">{view.note}</Alert>
      ) : view ? (
        <>
          <Stack direction="row" spacing={1.5} sx={{ mb: 1.5, alignItems: "center", flexShrink: 0 }}>
            <TextField
              size="small"
              fullWidth
              label="Filter by number, title, author or label"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setPage(1);
                setExpanded(null);
              }}
              slotProps={{
                input: {
                  startAdornment: (
                    <Box component="span" sx={{ display: "flex", color: "text.secondary", mr: 1 }}>
                      <SearchGlyph />
                    </Box>
                  ),
                },
              }}
            />
            <Chip
              size="small"
              variant="outlined"
              label={`${issues.length} / ${view.issues.length} issues`}
              sx={{ flexShrink: 0, height: 32 }}
            />
          </Stack>

          {/* One bounded scroll region: a single list with row dividers and hover,
           * not a stack of bordered cards. Header/pager stay pinned outside it. */}
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              pr: 0.5,
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              bgcolor: "background.paper",
            }}
          >
            {issues.length === 0 ? (
              <Stack spacing={1} sx={{ alignItems: "center", justifyContent: "center", py: 6 }}>
                <Box sx={{ color: "text.disabled", display: "flex" }}>
                  <SearchGlyph />
                </Box>
                <Typography variant="body2" color="text.secondary">
                  No issues match this filter.
                </Typography>
              </Stack>
            ) : (
              <Stack divider={<Divider flexItem />}>
                {pageIssues.map((issue) => {
                  const run = runsByNumber.get(issue.number);
                  /* Only status is predictable here: a queued rework does not
                   * prove its consumer is alive, and the backend allows resume. */
                  const active = run ? ACTIVE_RUN_STATUSES.has(run.status) : false;
                  /* Closed tickets are in the history for reference only. */
                  const startable = issue.state === STARTABLE_STATE;
                  return (
                    <IssueRow
                      key={issue.number}
                      issue={issue}
                      run={run}
                      active={active}
                      startable={startable}
                      starting={startingIssue === issue.number}
                      expanded={expanded === issue.number}
                      onToggle={() => setExpanded(expanded === issue.number ? null : issue.number)}
                      onStart={() => onStartIssue(issue.number)}
                      onOpenRun={() => run && onOpenRun(run.id)}
                    />
                  );
                })}
              </Stack>
            )}
          </Box>

          <Stack
            direction="row"
            spacing={2}
            sx={{ alignItems: "center", justifyContent: "space-between", pt: 1.5, flexShrink: 0 }}
          >
            <Typography variant="caption" color="text.secondary">
              Showing {first}–{last} of {issues.length}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Button size="small" disabled={safePage <= 1} onClick={() => { setPage(safePage - 1); setExpanded(null); }}>
                Previous
              </Button>
              <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
                Page {safePage} / {pageCount}
              </Typography>
              <Button size="small" disabled={safePage >= pageCount} onClick={() => { setPage(safePage + 1); setExpanded(null); }}>
                Next
              </Button>
            </Stack>
          </Stack>
        </>
      ) : null}
    </Box>
  );
}

function IssueRow({
  issue,
  run,
  active,
  startable,
  starting,
  expanded,
  onToggle,
  onStart,
  onOpenRun,
}: {
  issue: IssueEntry;
  run?: RunSummary;
  active: boolean;
  startable: boolean;
  starting: boolean;
  expanded: boolean;
  onToggle: () => void;
  onStart: () => void;
  onOpenRun: () => void;
}) {
  /* htmlUrl is validated on the server to an https://github.com/... URL, but
   * guard again here: a link is the one place a hand-edited snapshot could
   * otherwise turn into javascript: or an off-site target. */
  const safeUrl = issue.htmlUrl.startsWith("https://github.com/") ? issue.htmlUrl : "";
  return (
    <Box sx={{ px: 1.5, py: 1.25, transition: "background-color .12s", "&:hover": { bgcolor: "action.hover" } }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.25 }}>
        {/* The whole left region toggles the row; the action area below sits
         * outside it so clicking an action cannot also expand the row. */}
        <Box
          component="button"
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} issue #${issue.number}: ${issue.title || "no title"}`}
          onClick={onToggle}
          sx={{
            display: "flex",
            alignItems: "flex-start",
            gap: 1,
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            border: "none",
            background: "none",
            cursor: "pointer",
            p: 0,
            color: "inherit",
            font: "inherit",
          }}
        >
          <Box sx={{ color: "text.disabled", display: "flex", pt: 0.25, flexShrink: 0 }}>
            <ChevronGlyph expanded={expanded} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "baseline", flexWrap: "wrap", gap: 0.5 }}>
              <Typography variant="body2" sx={{ fontWeight: 700, color: PRIMARY, fontFamily: "monospace" }}>
                #{issue.number}
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600, wordBreak: "break-word" }}>
                {issue.title || "(no title)"}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={0.75} sx={{ flexWrap: "wrap", gap: 0.5, mt: 0.75, alignItems: "center" }}>
              <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                <Box
                  sx={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    bgcolor: issue.state === "open" ? "success.main" : "text.disabled",
                  }}
                />
                <Typography variant="caption" color="text.secondary" sx={{ textTransform: "capitalize", fontWeight: 600 }}>
                  {issue.state}
                </Typography>
              </Stack>
              {issue.labels.map((label) => (
                <Chip key={label} size="small" label={label} variant="outlined" sx={{ height: 20, fontSize: 10.5 }} />
              ))}
              {issue.comments > 0 ? (
                <Typography variant="caption" color="text.secondary" sx={{ ml: 0.25 }}>
                  {issue.comments} comments
                </Typography>
              ) : null}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
              {[issue.author ? `by ${issue.author}` : "", issue.updatedAt ? `updated ${formatLocalDateTime(issue.updatedAt)}` : ""]
                .filter(Boolean)
                .join(" · ")}
            </Typography>
          </Box>
        </Box>

        {/* Action area, outside the toggle button so clicking it cannot also
         * expand the row. Precedence: an active run would 409 → View run;
         * a closed/unknown issue is reference-only → no Start; else Start. */}
        <Stack direction="column" spacing={0.75} sx={{ alignItems: "flex-end", flexShrink: 0 }}>
          {active ? (
            <Button size="small" variant="outlined" onClick={onOpenRun} sx={{ textTransform: "none" }}>
              View run
            </Button>
          ) : startable ? (
            <Button size="small" variant="contained" onClick={onStart} disabled={starting} sx={{ textTransform: "none" }}>
              {starting ? <CircularProgress size={14} color="inherit" sx={{ mr: 0.75 }} /> : null}
              {starting ? "Starting…" : "Start"}
            </Button>
          ) : (
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
              Closed — not startable
            </Typography>
          )}
          {run ? (
            <Chip
              size="small"
              variant="outlined"
              color={statusColor(run.status)}
              label={`run: ${run.status}`}
              sx={{ height: 20, fontSize: 10.5 }}
            />
          ) : null}
        </Stack>
      </Box>
      {expanded ? (
        <Box sx={{ mt: 1.25, pt: 1.25, pl: 2.5, borderTop: 1, borderColor: "divider" }}>
          {issue.body ? (
            <Typography
              component="pre"
              variant="body2"
              sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word", bgcolor: "action.hover", p: 1.5, m: 0, borderRadius: 1 }}
            >
              {issue.body}
            </Typography>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              No body in the snapshot.
            </Typography>
          )}
          {safeUrl ? (
            <Link href={safeUrl} target="_blank" rel="noopener noreferrer" variant="body2" sx={{ display: "inline-block", mt: 1.25 }}>
              Open on GitHub
            </Link>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
