import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Box,
  Chip,
  CircularProgress,
  FormControl,
  IconButton,
  InputLabel,
  ListItemButton,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import type { Theme } from "@mui/material/styles";
import { formatLocalDateTime, statusColor, statusLabel, type RunSummary } from "@/lib/shared";

const DRAWER_WIDTH = 280;

function statusDotColor(theme: Theme, status: string): string {
  switch (statusColor(status)) {
    case "success":
      return theme.palette.success.main;
    case "error":
      return theme.palette.error.main;
    case "warning":
      return theme.palette.warning.main;
    case "info":
      return theme.palette.info.main;
    default:
      return theme.palette.text.secondary;
  }
}

function DeleteIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" focusable="false" aria-hidden="true">
      <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
    </svg>
  );
}

/**
 * Left aside listing all runs. The list is virtualized (only visible rows
 * mount) because a reviewer's history can be long and rows are variable-height
 * (id + status chip + scope-guard chip). The delete button is a sibling of the
 * row button (absolutely positioned on the right), not nested inside it, so the
 * row keeps a single role=button tab stop.
 */
export function RunList({
  runs,
  selectedId,
  loading,
  error,
  onSelect,
  onDelete,
}: {
  runs: RunSummary[];
  selectedId: string | null;
  /** First load still in flight: show a spinner instead of "No runs yet." */
  loading: boolean;
  /** The last list load failed (and there is no data to show). */
  error: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "awaiting_review" | "failed" | "running" | "other">("all");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = runs.filter((run) => {
      const matchesQuery = !q || run.id.toLowerCase().includes(q);
      const matchesStatus =
        statusFilter === "all"
          ? true
          : statusFilter === "other"
            ? !["awaiting_review", "failed", "running"].includes(run.status)
            : run.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
    /* Newest fix first: order by when the run started, descending. Server
     * already returns this order — sort here too so a filter change keeps it
     * (Array.prototype.sort is stable, so ties keep the incoming order). */
    return filtered
      .map((run, index) => ({ run, index }))
      .sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt) || a.index - b.index)
      .map((entry) => entry.run);
  }, [runs, query, statusFilter]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // TanStack Virtual owns this hook's memoization; the React Compiler correctly
  // skips memoizing it, which is intended (not a stale-closure risk here).
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
  });

  /* Keyboard cursor for queue navigation (j/k or arrows). The cursor tracks the
   * focused run within the filtered + sorted list; j/k moves it and opens that
   * run while the virtualizer scrolls it into view. Click selection keeps the
   * cursor aligned so the two never drift apart. */
  const [cursor, setCursor] = useState(() => {
    const i = visible.findIndex((run) => run.id === selectedId);
    return i < 0 ? 0 : i;
  });
  const cursorRef = useRef(cursor);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  /* Keep the cursor on the selected run and scroll it into view whenever the
   * selection changes (click, keyboard, deep link, or delete auto-advance). */
  useEffect(() => {
    if (!selectedId) return;
    const idx = visible.findIndex((run) => run.id === selectedId);
    if (idx >= 0) {
      setCursor(idx);
      virtualizer.scrollToIndex(idx, { align: "auto" });
    }
  }, [selectedId, visible, virtualizer]);

  /* Window-level navigation: only acts in the runs view (this component is
   * unmounted otherwise), never while typing or a modal owns focus. */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "j" && event.key !== "k" && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"]')) return;
      if (visible.length === 0) return;
      event.preventDefault();
      const cur = cursorRef.current;
      const next =
        event.key === "j" || event.key === "ArrowDown"
          ? Math.min(cur + 1, visible.length - 1)
          : Math.max(cur - 1, 0);
      if (next === cur) return;
      cursorRef.current = next;
      setCursor(next);
      virtualizer.scrollToIndex(next, { align: "auto" });
      onSelect(visible[next].id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, onSelect, virtualizer]);

  return (
    <Box
      component="aside"
      sx={{
        width: DRAWER_WIDTH,
        flexShrink: 0,
        borderRight: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        minHeight: 0,
      }}
    >
      {/* Filter bar stays pinned so the reviewer can re-scope the queue without
       * losing their scroll position in a long list. */}
      <Box
        sx={{
          flexShrink: 0,
          p: 1,
          display: "flex",
          flexDirection: "column",
          gap: 1,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
        }}
      >
        <TextField
          size="small"
          placeholder="Filter by run id…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          fullWidth
        />
        <FormControl size="small" fullWidth>
          <InputLabel id="run-status-filter">Status</InputLabel>
          <Select
            labelId="run-status-filter"
            label="Status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          >
            <MenuItem value="all">All runs</MenuItem>
            <MenuItem value="awaiting_review">Awaiting review</MenuItem>
            <MenuItem value="failed">Failed</MenuItem>
            <MenuItem value="running">Running</MenuItem>
            <MenuItem value="other">Other</MenuItem>
          </Select>
        </FormControl>
      </Box>

      {loading ? (
        <Box sx={{ p: 4, display: "flex", justifyContent: "center" }}>
          <CircularProgress />
        </Box>
      ) : (
        <Box ref={scrollRef} sx={{ flex: 1, minHeight: 0, overflow: "auto", position: "relative" }}>
          {visible.length === 0 ? (
            <Box sx={{ p: 2 }}>
              <Typography color="text.secondary">
                {error ? "Could not load the run list." : runs.length === 0 ? "No runs yet." : "No runs match the filter."}
              </Typography>
            </Box>
          ) : (
            <Box sx={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const run = visible[vi.index];
                const awaiting = run.status === "awaiting_review";
                return (
                  <Box
                    key={run.id}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    sx={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vi.start}px)`,
                      borderLeft: awaiting ? `3px solid ${theme.palette.primary.main}` : "3px solid transparent",
                      bgcolor: awaiting ? "action.hover" : "transparent",
                    }}
                  >
                    <ListItemButton
                      selected={run.id === selectedId}
                      onClick={() => {
                        setCursor(vi.index);
                        onSelect(run.id);
                      }}
                      alignItems="flex-start"
                      sx={{ gap: 1, pr: 5 }}
                    >
                      <ListItemText
                        primary={
                          <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
                            <Box
                              component="span"
                              aria-hidden="true"
                              sx={{
                                width: 8,
                                height: 8,
                                borderRadius: "50%",
                                flexShrink: 0,
                                bgcolor: statusDotColor(theme, run.status),
                              }}
                            />
                            <Typography sx={{ fontWeight: awaiting ? 800 : 700 }}>{run.id}</Typography>
                            <Chip size="small" label={statusLabel(run.status)} color={statusColor(run.status)} />
                            {run.genericPack ? (
                              <Tooltip title={`Pack ${run.pack ?? "(unrecorded)"} has no dedicated module adapter — no scope guard or automatic pack check was applied; the gate-4 audit is the only backstop.`}>
                                <Chip size="small" label="⚠ no scope guard" color="warning" variant="outlined" />
                              </Tooltip>
                            ) : null}
                          </Stack>
                        }
                        secondary={formatLocalDateTime(run.startedAt)}
                      />
                    </ListItemButton>
                    {run.status !== "running" && (
                      <Tooltip title={`Delete ${run.id}`}>
                        <IconButton
                          className="run-delete"
                          aria-label={`Delete ${run.id}`}
                          size="small"
                          sx={{
                            position: "absolute",
                            top: 8,
                            right: 4,
                            opacity: 0.5,
                            /* No hover on touch devices: keep the affordance clearly visible. */
                            "@media (hover: none)": { opacity: 0.9 },
                            "&:hover": { opacity: 1 },
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            onDelete(run.id);
                          }}
                        >
                          <DeleteIcon />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
