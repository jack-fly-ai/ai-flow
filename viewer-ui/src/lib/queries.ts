/* Server-state layer: every request/response fetch now flows through TanStack
 * Query. This replaces the previous hand-rolled scheme in App —
 * the monotonic request sequence, the per-poll in-flight guards and the
 * document.hidden skip are all built into Query's dedup/cancel/refetch model:
 *   - refetchInterval gives the 3s cadence;
 *   - refetchIntervalInBackground: false means a hidden tab stops polling
 *     (the previous `document.hidden` guard);
 *   - `enabled` lets the login gate stall polling until a session exists;
 *   - Query keeps only the latest response, so a slow refresh can never
 *     overwrite newer data (the previous seqRef guard).
 * The live LOG is an EventSource stream and stays in LiveLogPanel — streams
 * are not request/response, so they are intentionally outside this layer. */

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { RUN_POLL_INTERVAL_MS } from "@/lib/constants";
import type { RunDetail, RunSummary, SessionInfo } from "@/lib/shared";

async function getJson<T>(path: string): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
  return (await response.json()) as T;
}

export function useRuns(enabled: boolean) {
  return useQuery({
    queryKey: ["runs"],
    queryFn: () => getJson<{ runs: RunSummary[] }>("/api/runs").then((body) => body.runs),
    enabled,
    refetchInterval: RUN_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

export function useRunDetail(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["run", id],
    queryFn: () => getJson<RunDetail>(`/api/runs/${encodeURIComponent(id as string)}`),
    enabled: enabled && !!id,
    refetchInterval: RUN_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

export function useSessionInfo(enabled: boolean) {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => getJson<SessionInfo>("/api/session"),
    enabled,
    retry: false,
    refetchInterval: false,
    staleTime: Infinity,
  });
}

/** Re-pull the runs list and the selected run after a mutating action. */
export async function refreshAfterMutation(client: QueryClient, selectedId: string | null): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: ["runs"] }),
    selectedId ? client.invalidateQueries({ queryKey: ["run", selectedId] }) : Promise.resolve(),
  ]);
}
