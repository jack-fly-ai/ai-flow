import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { onUnauthorized } from "@/lib/api";
import { LiveLogPanel } from "@/components/LiveLogPanel";

/* LiveLogPanel is the only real-time surface in the viewer: it streams the
 * active stage's log over SSE and must degrade to polling when the stream
 * persistently fails (auth broken, server gone) instead of silently showing a
 * stale panel. jsdom has no EventSource, so these tests drive a fake that
 * records the handlers the component installs. */

interface FakeSource {
  url: string;
  closed: boolean;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  emit(data: string): void;
  emitError(): void;
}

let sources: FakeSource[] = [];

class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    sources.push(this as unknown as FakeSource);
  }
  emit(data: string): void {
    this.onmessage?.({ data });
  }
  emitError(): void {
    this.onerror?.();
  }
  close(): void {
    this.closed = true;
  }
}

function stubFetch(handler: (input: string) => Partial<{ status: number; ok: boolean; json: () => unknown }>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string) => {
    const base = { status: 200, ok: true, json: async () => ({ exists: false, content: "", stage: "", truncated: false }) };
    return { ...base, ...handler(input) };
  }) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  sources = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LiveLogPanel — SSE path", () => {
  it("renders streamed frames in real time", async () => {
    stubFetch(() => ({ status: 200, ok: true }));
    render(<LiveLogPanel runId="123" stage="phase2" />);

    await waitFor(() => expect(sources.length).toBe(1));
    expect(sources[0].url).toContain("/api/runs/123/logs/phase2/stream");

    act(() => {
      sources[0].emit(JSON.stringify({ exists: true, content: "compiling widgets…", stage: "phase2", truncated: false }));
    });
    expect(screen.getByRole("log").textContent).toContain("compiling widgets…");
    expect(screen.queryByText(/Live streaming is unavailable/)).toBeNull();
  });

  it("tolerates a transient stream error and keeps streaming", async () => {
    stubFetch(() => ({ status: 200, ok: true }));
    render(<LiveLogPanel runId="123" stage="phase2" />);
    await waitFor(() => expect(sources.length).toBe(1));

    /* One error is a transient blip (EventSource reconnects on its own):
     * no fallback notice, and later frames still render. */
    await act(async () => {
      sources[0].emitError();
    });
    expect(screen.queryByText(/Live streaming is unavailable/)).toBeNull();

    act(() => {
      sources[0].emit(JSON.stringify({ exists: true, content: "after reconnect", stage: "phase2", truncated: false }));
    });
    expect(screen.getByRole("log").textContent).toContain("after reconnect");
  });
});

describe("LiveLogPanel — SSE failure fallback", () => {
  it("falls back to polling after persistent stream failures", async () => {
    const fetchMock = stubFetch(() => ({
      status: 200,
      ok: true,
      json: async () => ({ exists: true, content: "polled output", stage: "phase2", truncated: false }),
    }));
    render(<LiveLogPanel runId="123" stage="phase2" />);
    await waitFor(() => expect(sources.length).toBe(1));

    /* Three consecutive errors exceed the reconnect budget: the component
     * must close the stream and switch to the 2s polling path. */
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        sources[0].emitError();
      });
    }

    await waitFor(() => expect(screen.getByText(/Live streaming is unavailable/)).toBeTruthy());
    expect(sources[0].closed).toBe(true);
    /* The polling path fetches the plain (non-stream) endpoint. */
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/runs/123/logs/phase2", expect.anything()));
    await waitFor(() => expect(screen.getByRole("log").textContent).toContain("polled output"));
  });

  it("falls back immediately and re-prompts when the stream 401s (broken token)", async () => {
    /* The probe returns 401: apiFetch itself emits the re-login event, and the
     * panel must not wait out the reconnect budget on a stream that can never
     * authenticate. */
    stubFetch(() => ({ status: 401, ok: false }));
    const unauthorized = vi.fn();
    const off = onUnauthorized(unauthorized);
    try {
      render(<LiveLogPanel runId="123" stage="phase2" />);
      await waitFor(() => expect(sources.length).toBe(1));

      await act(async () => {
        sources[0].emitError();
      });

      await waitFor(() => expect(unauthorized).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText(/Live streaming is unavailable/)).toBeTruthy());
    } finally {
      off();
    }
  });
});

describe("LiveLogPanel — polling path", () => {
  it("polls when the browser has no EventSource", async () => {
    vi.stubGlobal("EventSource", undefined);
    const fetchMock = stubFetch(() => ({
      status: 200,
      ok: true,
      json: async () => ({ exists: true, content: "polled without sse", stage: "phase2", truncated: false }),
    }));
    render(<LiveLogPanel runId="123" stage="phase2" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/runs/123/logs/phase2", expect.anything()));
    await waitFor(() => expect(screen.getByRole("log").textContent).toContain("polled without sse"));
    expect(screen.queryByText(/Live streaming is unavailable/)).toBeNull();
  });
});
