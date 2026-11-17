import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, downloadUrl, getStoredToken, onUnauthorized, prefillTokenFromUrl, setStoredToken } from "@/lib/api";

/* api.ts is the token plumbing for the whole viewer: sessionStorage custody,
 * the Bearer header, the ?token= channel EventSource/downloads must use, and
 * the 401 event the login gate listens on. */

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  sessionStorage.clear();
});

describe("token storage", () => {
  it("round-trips the token through sessionStorage", () => {
    expect(getStoredToken()).toBe("");
    setStoredToken("tok-123");
    expect(getStoredToken()).toBe("tok-123");
    setStoredToken("");
    expect(getStoredToken()).toBe("");
  });

  it("prefills from ?token= (operator convenience link)", () => {
    window.history.replaceState({}, "", "/?token=abc%20def");
    prefillTokenFromUrl();
    expect(getStoredToken()).toBe("abc def");
  });
});

describe("apiFetch", () => {
  it("attaches the Bearer header and emits the 401 event", async () => {
    setStoredToken("tok-123");
    const unauthorized = vi.fn();
    const off = onUnauthorized(unauthorized);
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => ({ status: 401, ok: false }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const response = await apiFetch("/api/session");

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/session");
    expect((init!.headers as Headers).get("authorization")).toBe("Bearer tok-123");
    expect(unauthorized).toHaveBeenCalledTimes(1);
    off();
  });

  it("does not emit the 401 event on a successful response", async () => {
    setStoredToken("tok-123");
    const unauthorized = vi.fn();
    const off = onUnauthorized(unauthorized);
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true }) as unknown as Response));

    const response = await apiFetch("/api/runs");

    expect(response.status).toBe(200);
    expect(unauthorized).not.toHaveBeenCalled();
    off();
  });
});

describe("downloadUrl", () => {
  it("appends the token as a query parameter (EventSource/<a> cannot send headers)", () => {
    setStoredToken("tok-123");
    expect(downloadUrl("/api/runs/1/package")).toBe("/api/runs/1/package?token=tok-123");
    expect(downloadUrl("/api/runs/1/logs/phase2?raw=1")).toBe("/api/runs/1/logs/phase2?raw=1&token=tok-123");
  });

  it("passes the path through untouched when no token is stored", () => {
    expect(downloadUrl("/api/runs/1/package")).toBe("/api/runs/1/package");
  });
});
