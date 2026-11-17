/* Fetch wrapper for the viewer API. When ui.token protects the server, the
 * token is stored in sessionStorage (per-tab, no cookie/localStorage) and sent
 * as Authorization: Bearer; a 401 notifies the app to show the token prompt. */

import type { SessionInfo } from "./shared.js";
export type { SessionInfo };

const TOKEN_KEY = "aiflow.token";

export function getStoredToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

let unauthorizedEmitted = false;

export function setStoredToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* sessionStorage unavailable (private mode, storage disabled): the
     * token simply is not remembered; the user re-enters it next 401. */
  }
  /* A newly submitted token re-arms the 401 signal. */
  unauthorizedEmitted = false;
}

type UnauthorizedListener = () => void;
const listeners = new Set<UnauthorizedListener>();

/** Subscribe to 401 events (the app shows the token prompt). Returns an unsubscribe. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitUnauthorized(): void {
  /* Flip the login gate once per token, not once per 401. */
  if (unauthorizedEmitted) return;
  unauthorizedEmitted = true;
  for (const listener of [...listeners]) listener();
}

/** fetch with the stored token attached; flags 401s for the token prompt. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getStoredToken();
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) emitUnauthorized();
  return response;
}

/* For callers that cannot attach a header (e.g. EventSource). Prefer
 * downloadBlob for ordinary downloads so the token stays in the header. */
export function downloadUrl(path: string): string {
  const token = getStoredToken();
  if (!token) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

/** Honour the server's filename instead of downloading a tarball as "package". */
function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(value) ?? /filename\s*=\s*([^;]+)/i.exec(value);
  const raw = star?.[1] ?? plain?.[1];
  if (!raw) return null;
  let name = raw.trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep the raw value if it is not percent-encoded
  }
  return name.replace(/[/\\]/g, "_") || null;
}

/* Download via fetch with the Authorization header rather than the token query
 * string, so the credential never lands in browser history or server access
 * logs. Falls back to the filename in the path when none is supplied. */
export async function downloadBlob(path: string, filename?: string): Promise<void> {
  const response = await apiFetch(path);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download =
      filename ??
      filenameFromDisposition(response.headers.get("content-disposition")) ??
      path.split("/").pop() ??
      "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/* `?token=` is a bearer credential: consume it once and strip it from the URL
 * so it cannot land in history, proxy logs or Referer. */
export function prefillTokenFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("token");
    if (!token) return;
    setStoredToken(token);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // not a browser location
  }
}

/** The session for the stored token; null on 401/network failure. */
export async function fetchSession(): Promise<SessionInfo | null> {
  try {
    const response = await apiFetch("/api/session");
    if (!response.ok) return null;
    return (await response.json()) as SessionInfo;
  } catch {
    return null;
  }
}
