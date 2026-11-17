import { apiFetch } from "@/lib/api";
import type { McpProbeResult } from "@/lib/shared";
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";

type McpServerType = "stdio" | "sse" | "http";
type McpScopeName = "user" | "project";

interface McpServerEntry {
  name: string;
  type: McpServerType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}

interface McpScope {
  scope: McpScopeName;
  path: string;
  format: string;
  requiresApproval: boolean;
  verified: boolean;
  note: string;
  warning?: string;
  servers: McpServerEntry[];
}

interface McpStatus {
  agent: string | null;
  label: string | null;
  supported: boolean;
  error?: string;
  scopes: McpScope[];
}

/* Small inline SVG glyph — the project deliberately avoids @mui/icons-material
 * to keep the bundle lean; this matches the other panels' line-icon language. */
function RefreshGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

function parseArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Operator-only MCP configuration. This is a PERSISTENT main-area view (not a
 * dialog): it is a browse+edit surface — scoped server lists beside a full add/
 * edit form, with an inline delete confirmation — that needs the whole width and
 * must not trap focus. It stays mounted so an in-progress edit survives a view
 * switch; `visible` reloads the config each time it comes on screen. The agent
 * only consumes these servers; it can never edit its own tool surface (hard rule).
 */
export function McpPanel({ visible }: { visible: boolean }) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<{ scope: McpScopeName; name: string } | null>(null);
  /* Per-server availability check: which row is probing + the last result of
   * each server, keyed by "scope/name". Results are redacted server-side. */
  const [probing, setProbing] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, McpProbeResult>>({});

  const [editScope, setEditScope] = useState<McpScopeName>("user");
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState<McpServerType>("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [envText, setEnvText] = useState("");
  const [enabled, setEnabled] = useState(true);

  const serverEnabled = (server: McpServerEntry): boolean => server.enabled !== false;

  /* The load-effect passes a cancellation PREDICATE (not a boolean): a boolean
   * would be frozen at false when the fetch starts, so a late response could
   * still write into a panel that has since been hidden/re-shown. Callers that
   * are not cancellable (save/toggle/remove refreshing the list) omit it. */
  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch("/api/mcp");
      const body = (await res.json()) as McpStatus;
      if (isCancelled()) return;
      setStatus(body);
      if (body.scopes.length > 0) setEditScope(body.scopes[0].scope);
    } catch {
      if (!isCancelled()) setError("Could not load the MCP configuration.");
    } finally {
      if (!isCancelled()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    /* The panel reloads its MCP config when it comes on screen; load() sets
     * state only in its ASYNC continuation (after the fetch), so no synchronous
     * cascading render happens here. The cancellation predicate keeps a response
     * that arrives after the panel was hidden from writing stale config into it. */
    if (!visible) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async load on show; setState runs after await
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [visible, load]);

  const resetForm = useCallback(() => {
    setEditName("");
    setEditType("stdio");
    setCommand("");
    setArgsText("");
    setUrl("");
    setEnvText("");
    setEnabled(true);
  }, []);

  const startEdit = useCallback((scope: McpScopeName, server: McpServerEntry) => {
    setEditScope(scope);
    setEditName(server.name);
    setEditType(server.type);
    setCommand(server.command ?? "");
    setArgsText((server.args ?? []).join("\n"));
    setUrl(server.url ?? "");
    setEnvText(Object.entries(server.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"));
    setEnabled(serverEnabled(server));
  }, []);

  const save = useCallback(async () => {
    if (!status) return;
    setBusy(true);
    setError("");
    const spec: Record<string, unknown> = { type: editType, enabled };
    if (editType === "stdio") {
      spec.command = command.trim();
      const args = parseArgs(argsText);
      if (args.length > 0) spec.args = args;
      const env = parseEnv(envText);
      if (Object.keys(env).length > 0) spec.env = env;
    } else {
      spec.url = url.trim();
    }
    try {
      const res = await apiFetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: editScope, name: editName.trim(), spec }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error || `Failed to save (${res.status})`);
        return;
      }
      resetForm();
      await load();
    } catch {
      setError("Could not save the server.");
    } finally {
      setBusy(false);
    }
  }, [status, editScope, editName, editType, command, argsText, url, envText, enabled, load, resetForm]);

  const toggle = useCallback(
    async (scope: McpScopeName, name: string, next: boolean) => {
      setBusy(true);
      setError("");
      try {
        const res = await apiFetch(`/api/mcp/${encodeURIComponent(name)}?scope=${encodeURIComponent(scope)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: next }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setError(body.error || `Failed to update (${res.status})`);
          return;
        }
        await load();
      } catch {
        setError("Could not update the server.");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const remove = useCallback(
    async (scope: McpScopeName, name: string) => {
      setBusy(true);
      setError("");
      try {
        const res = await apiFetch(
          `/api/mcp/${encodeURIComponent(name)}?scope=${encodeURIComponent(scope)}`,
          { method: "DELETE" },
        );
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setError(body.error || `Failed to delete (${res.status})`);
          return;
        }
        await load();
      } catch {
        setError("Could not delete the server.");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const probeKey = useCallback((scope: McpScopeName, name: string) => `${scope}/${name}`, []);

  const checkServer = useCallback(
    async (scope: McpScopeName, name: string) => {
      const key = probeKey(scope, name);
      if (probing) return;
      setProbing(key);
      setProbeResults((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      try {
        const res = await apiFetch(
          `/api/mcp/probe?name=${encodeURIComponent(name)}&scope=${encodeURIComponent(scope)}`,
          { method: "POST" },
        );
        const body = (await res.json().catch(() => ({}))) as McpProbeResult & { error?: string };
        if (!res.ok) {
          setProbeResults((prev) => ({
            ...prev,
            [key]: { ok: false, detail: body.error || `Check failed (${res.status})` },
          }));
          return;
        }
        setProbeResults((prev) => ({ ...prev, [key]: body }));
      } catch {
        setProbeResults((prev) => ({ ...prev, [key]: { ok: false, detail: "Could not reach the check endpoint." } }));
      } finally {
        setProbing(null);
      }
    },
    [probeKey, probing],
  );

  const nameInvalid = !/^[A-Za-z0-9_-]+$/.test(editName.trim());
  const canSave =
    !busy &&
    !nameInvalid &&
    (editType === "stdio" ? command.trim().length > 0 : url.trim().length > 0);

  const editScopeFormat = status?.scopes.find((scope) => scope.scope === editScope)?.format ?? "";

  return (
    <Box sx={{ display: visible ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Header: title + agent on one line, reload beside it. */}
      <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", mb: 1.5, gap: 2, flexShrink: 0 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
            Manage MCP servers
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {status?.label ?? status?.agent ?? "Configured agent"} · operator only
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
          Reload
        </Button>
      </Stack>

      {/* Compact read-only notice. */}
      <Alert severity="info" sx={{ mb: 2, flexShrink: 0 }}>
        You edit the configured agent&apos;s MCP servers here. The agent only consumes them; it cannot
        modify this list itself. Changes apply the next time a run starts the agent — except DeepSeek
        Harness (dsh), which hot-reloads edits via HMR.
      </Alert>

      {/* One bounded scroll region; lists and editor stay side by side on wide screens. */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pr: 0.5 }}>
        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
            <CircularProgress />
          </Box>
        ) : error && !status ? (
          <Alert severity="error">{error}</Alert>
        ) : status && !status.supported ? (
          <Alert severity="warning">
            {status.error ?? `MCP management is not configured for agent "${status.agent}".`}
          </Alert>
        ) : status ? (
          <Stack direction={{ xs: "column", md: "row" }} spacing={3} sx={{ alignItems: "flex-start" }}>
            {/* Left: the configured servers, grouped by scope. */}
            <Box sx={{ flex: 1, minWidth: 0, width: "100%" }}>
              {status.scopes.map((scope) => (
                <Box key={scope.scope} sx={{ mb: 3 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 700, textTransform: "capitalize" }}>
                    {scope.scope} scope
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5, wordBreak: "break-all" }}>
                    {scope.path}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    {scope.note}
                    {!scope.verified ? " (best-effort: verify with your agent version)" : ""}
                  </Typography>
                  {scope.requiresApproval ? (
                    <Alert severity="warning" sx={{ mb: 1 }}>
                      This file&apos;s servers stay disabled until you approve them in the agent (for example
                      Claude Code&apos;s <code>/mcp</code>).
                    </Alert>
                  ) : null}
                  {scope.warning ? (
                    <Alert severity="warning" sx={{ mb: 1 }}>
                      {scope.warning}. Manage MCP cannot write this file until it is repaired — edits are refused to
                      avoid destroying the rest of your config.
                    </Alert>
                  ) : null}

                  {scope.servers.length === 0 ? (
                    <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic" }}>
                      No servers configured.
                    </Typography>
                  ) : (
                    <Stack component="ul" spacing={1} sx={{ pl: 2, m: 0 }}>
                      {scope.servers.map((server) => {
                        const confirming = confirmRemove?.scope === scope.scope && confirmRemove.name === server.name;
                        const key = probeKey(scope.scope, server.name);
                        const probeResult = probeResults[key];
                        const isProbing = probing === key;
                        return (
                          <Box
                            component="li"
                            key={server.name}
                            sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}
                          >
                            <Box sx={{ flex: 1, minWidth: 220 }}>
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                {server.name}{" "}
                                <Typography component="span" color="text.secondary">
                                  ({server.type})
                                </Typography>
                                {!serverEnabled(server) ? (
                                  <Typography component="span" color="warning.main" sx={{ ml: 1 }}>
                                    (disabled)
                                  </Typography>
                                ) : null}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" sx={{ display: "block", wordBreak: "break-all" }}>
                                {server.type === "stdio"
                                  ? `${server.command ?? ""}${server.args && server.args.length > 0 ? " " + server.args.join(" ") : ""}`
                                  : server.url ?? ""}
                              </Typography>
                              {isProbing ? (
                                <Typography variant="caption" color="text.secondary" sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 0.5 }}>
                                  <CircularProgress size={12} /> Checking availability…
                                </Typography>
                              ) : probeResult ? (
                                <Typography
                                  variant="caption"
                                  color={probeResult.ok ? "success.main" : "error.main"}
                                  sx={{ display: "block", mt: 0.5, wordBreak: "break-word" }}
                                >
                                  {probeResult.ok ? "✓" : "✕"} {probeResult.detail}
                                  {probeResult.ok && probeResult.serverInfo ? ` · ${probeResult.serverInfo}` : ""}
                                </Typography>
                              ) : null}
                            </Box>
                            {confirming ? (
                              /* Inline confirmation replaces this row's controls — no nested modal. */
                              <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
                                <Typography variant="caption" color="text.secondary">
                                  Delete <code>{server.name}</code>?
                                </Typography>
                                <Button size="small" onClick={() => setConfirmRemove(null)} disabled={busy}>
                                  Cancel
                                </Button>
                                <Button
                                  size="small"
                                  variant="contained"
                                  color="error"
                                  disabled={busy}
                                  onClick={() => {
                                    void remove(scope.scope, server.name);
                                    setConfirmRemove(null);
                                  }}
                                >
                                  Delete
                                </Button>
                              </Stack>
                            ) : (
                              <>
                                <Switch
                                  size="small"
                                  checked={serverEnabled(server)}
                                  disabled={busy}
                                  onChange={(event) => void toggle(scope.scope, server.name, event.target.checked)}
                                  slotProps={{ input: { "aria-label": `Enable ${server.name}` } }}
                                />
                                <Button
                                  size="small"
                                  variant="outlined"
                                  disabled={busy || !!probing}
                                  onClick={() => void checkServer(scope.scope, server.name)}
                                >
                                  Check
                                </Button>
                                <Button size="small" variant="outlined" onClick={() => startEdit(scope.scope, server)}>
                                  Edit
                                </Button>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  color="error"
                                  disabled={busy}
                                  onClick={() => setConfirmRemove({ scope: scope.scope, name: server.name })}
                                >
                                  Delete
                                </Button>
                              </>
                            )}
                          </Box>
                        );
                      })}
                    </Stack>
                  )}
                  <Divider sx={{ mt: 2 }} />
                </Box>
              ))}
            </Box>

            {/* Right: the add/edit form, in its own subtle surface. */}
            <Box
              sx={{
                width: { xs: "100%", md: 400 },
                flexShrink: 0,
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
                bgcolor: "background.paper",
                p: 2,
              }}
            >
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {editName ? `Edit server: ${editName}` : "Add a server"}
              </Typography>
              <Stack spacing={2} sx={{ mt: 1 }}>
                <TextField
                  select
                  label="Scope"
                  value={editScope}
                  onChange={(event) => setEditScope(event.target.value as McpScopeName)}
                  sx={{ minWidth: 140 }}
                >
                  {status.scopes.map((scope) => (
                    <MenuItem key={scope.scope} value={scope.scope}>
                      {scope.scope}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  label="Name"
                  value={editName}
                  onChange={(event) => setEditName(event.target.value)}
                  error={editName.length > 0 && nameInvalid}
                  helperText={editName.length > 0 && nameInvalid ? "Use letters, digits, - or _" : ""}
                  fullWidth
                />
                <TextField
                  select
                  label="Type"
                  value={editType}
                  onChange={(event) => setEditType(event.target.value as McpServerType)}
                  sx={{ minWidth: 140 }}
                >
                  <MenuItem value="stdio">stdio</MenuItem>
                  <MenuItem value="sse">sse</MenuItem>
                  <MenuItem value="http">http</MenuItem>
                </TextField>

                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <Switch
                    checked={enabled}
                    onChange={(event) => setEnabled(event.target.checked)}
                    slotProps={{ input: { "aria-label": "Enabled" } }}
                  />
                  <Typography variant="body2">{enabled ? "Enabled" : "Disabled"}</Typography>
                </Stack>

                {editType === "stdio" ? (
                  <>
                    <TextField
                      label="Command"
                      value={command}
                      onChange={(event) => setCommand(event.target.value)}
                      placeholder="npx"
                      fullWidth
                    />
                    <TextField
                      label="Arguments (one per line)"
                      value={argsText}
                      onChange={(event) => setArgsText(event.target.value)}
                      placeholder="-y\n@modelcontextprotocol/server-filesystem\n/workspace"
                      multiline
                      minRows={2}
                      fullWidth
                    />
                    <TextField
                      label="Environment (KEY=value per line)"
                      value={envText}
                      onChange={(event) => setEnvText(event.target.value)}
                      multiline
                      minRows={2}
                      fullWidth
                    />
                  </>
                ) : (
                  <>
                    {editType === "sse" && editScopeFormat === "dsh-cordis" ? (
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
                        dsh&apos;s MCP client supports only stdio and streamable-http, so this sse server is stored as streamable-http.
                      </Typography>
                    ) : null}
                    <TextField
                      label="URL"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="https://example.com/mcp"
                      fullWidth
                    />
                  </>
                )}

                {error ? <Alert severity="error">{error}</Alert> : null}

                <Stack direction="row" spacing={1}>
                  <Button variant="contained" onClick={() => void save()} disabled={!canSave}>
                    {busy ? <CircularProgress size={18} color="inherit" sx={{ mr: 1 }} /> : null}
                    Save
                  </Button>
                  <Button variant="outlined" onClick={resetForm} disabled={busy}>
                    Clear
                  </Button>
                </Stack>
              </Stack>
            </Box>
          </Stack>
        ) : null}
      </Box>
    </Box>
  );
}
