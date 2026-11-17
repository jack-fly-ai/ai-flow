import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IssueHistoryPanel } from "@/pages/IssueHistory";
import type { IssueEntry, IssuesView, RunSummary } from "@/lib/shared";

/* the issue list is a PERSISTENT main-area view (the default when no
 * run is selected), not a modal. It renders a LOCAL snapshot, warns that it is
 * not live GitHub state. "Start" is the ONLY entry point for launching a run:
 * it asks App to start that issue directly (App POSTs /api/runs), so the panel
 * itself never fires a request and active/closed issues offer no start. */

function stubIssues(view: IssuesView): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => ({ ok: true, status: 200, json: async () => view }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

const entry: IssueEntry = {
  number: 123,
  title: "Fix the viewer list",
  state: "open",
  htmlUrl: "https://github.com/acme/webapp/issues/123",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  author: "alice",
  labels: ["bug", "ui"],
  comments: 3,
  body: "The list is wrong",
};

const base: IssuesView = {
  ready: true,
  repo: "acme/webapp",
  syncedAt: new Date().toISOString(),
  stale: false,
  truncated: false,
  issues: [entry],
  note: "",
};

function runSummary(id: string, status: string): RunSummary {
  return {
    id, owner: null, stage: "phase2", status, startedAt: "2026-01-01T00:00:00Z",
    testVerdict: null, error: null,
  };
}

function renderPanel(overrides: {
  runs?: RunSummary[];
  visible?: boolean;
  startingIssue?: number | null;
  onStartIssue?: (n: number) => void;
  onOpenRun?: (id: string) => void;
} = {}) {
  const onStartIssue = overrides.onStartIssue ?? vi.fn();
  const onOpenRun = overrides.onOpenRun ?? vi.fn();
  const props = {
    runs: overrides.runs ?? [],
    visible: overrides.visible ?? true,
    startingIssue: overrides.startingIssue ?? null,
    onStartIssue,
    onOpenRun,
  };
  const rendered = render(<IssueHistoryPanel {...props} />);
  const setVisible = (visible: boolean) => rendered.rerender(<IssueHistoryPanel {...props} visible={visible} />);
  return { onStartIssue, onOpenRun, setVisible };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IssueHistoryPanel — persistent read-only snapshot view", () => {
  it("states it is a point-in-time snapshot and lists issues without a nested modal or silent start", async () => {
    const fetchMock = stubIssues(base);
    renderPanel();
    await waitFor(() => expect(screen.getByText("Fix the viewer list")).toBeTruthy());

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/issues");
    expect(screen.getByText(/point-in-time snapshot/i)).toBeTruthy();
    expect(screen.getAllByText(/ai-flow sync-issues/).length).toBeGreaterThan(0);
    expect(screen.getByText("#123")).toBeTruthy();
    expect(screen.getByText(/acme\/webapp/)).toBeTruthy();
    // No dialog: Start is an inline row action that asks App to launch the issue.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/Create task/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
  });

  it("warns when the snapshot is stale", async () => {
    stubIssues({ ...base, stale: true, note: "re-run sync" });
    renderPanel();
    await waitFor(() => expect(screen.getByText(/may be outdated/i)).toBeTruthy());
    expect(screen.getByText(/re-run sync/)).toBeTruthy();
  });

  it("shows the sync hint instead of a list when no snapshot exists", async () => {
    stubIssues({
      ready: false, repo: null, syncedAt: null, stale: false, truncated: false,
      issues: [], note: "No issue snapshot yet. Run 'ai-flow sync-issues' on the server to fetch one.",
    });
    renderPanel();
    await waitFor(() => expect(screen.getAllByText(/ai-flow sync-issues/).length).toBeGreaterThan(0));
    expect(screen.queryByText("Fix the viewer list")).toBeNull();
    expect(screen.queryByRole("button", { name: /Previous/ })).toBeNull();
  });

  it("filters by number/title/label and expands the body", async () => {
    stubIssues({ ...base, issues: [entry, { ...entry, number: 124, title: "Unrelated ticket", labels: ["docs"] }] });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByText("Unrelated ticket")).toBeTruthy());

    await user.type(screen.getByLabelText(/Filter by/), "123");
    expect(screen.getByText("Fix the viewer list")).toBeTruthy();
    expect(screen.queryByText("Unrelated ticket")).toBeNull();
    expect(screen.getByText(/Showing 1–1 of 1/)).toBeTruthy();

    await user.clear(screen.getByLabelText(/Filter by/));
    await user.type(screen.getByLabelText(/Filter by/), "docs");
    expect(screen.getByText("Unrelated ticket")).toBeTruthy();
    expect(screen.queryByText("Fix the viewer list")).toBeNull();

    await user.clear(screen.getByLabelText(/Filter by/));
    await user.click(screen.getByText("Fix the viewer list"));
    expect(screen.getByText("The list is wrong")).toBeTruthy();
    expect(screen.getByText("Open on GitHub").getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("paginates at 50 rows per page instead of rendering the whole snapshot", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ ...entry, number: i + 1, title: `Issue ${i + 1}` }));
    stubIssues({ ...base, issues: many });
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByText("Issue 1")).toBeTruthy());

    expect(screen.getByText(/Showing 1–50 of 120/)).toBeTruthy();
    expect(screen.getByText("Page 1 / 3")).toBeTruthy();
    expect(screen.queryByText("Issue 51")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Issue 51")).toBeTruthy();
    expect(screen.queryByText("Issue 1")).toBeNull();
    expect(screen.getByText(/Showing 51–100 of 120/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Issue 101")).toBeTruthy();
    expect(screen.getByText(/Showing 101–120 of 120/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
  });

  it("Start asks App to launch the issue (the panel itself never POSTs)", async () => {
    stubIssues(base);
    const user = userEvent.setup();
    const { onStartIssue } = renderPanel();
    await waitFor(() => expect(screen.getByText("Fix the viewer list")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(onStartIssue).toHaveBeenCalledWith(123);
    // App owns the POST; the panel shows a busy state only via the startingIssue prop.
    expect(screen.queryByText(/Starting/)).toBeNull();
  });

  it("disables the row's Start while that issue is launching", async () => {
    stubIssues(base);
    renderPanel({ startingIssue: 123 });
    await waitFor(() => expect(screen.getByText("Fix the viewer list")).toBeTruthy());

    expect(screen.getByText(/Starting/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("an issue with an active run offers View run instead of a start that would 409", async () => {
    stubIssues(base);
    const user = userEvent.setup();
    const { onStartIssue, onOpenRun } = renderPanel({ runs: [runSummary("123", "running")] });
    await waitFor(() => expect(screen.getByText("Fix the viewer list")).toBeTruthy());

    expect(screen.getByText("run: running")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "View run" }));
    expect(onOpenRun).toHaveBeenCalledWith("123");
    expect(onStartIssue).not.toHaveBeenCalled();
  });

  it("a failed run may be started again (backend allows resume/retry)", async () => {
    stubIssues(base);
    renderPanel({ runs: [runSummary("123", "failed")] });
    await waitFor(() => expect(screen.getByText("Fix the viewer list")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(screen.getByText("run: failed")).toBeTruthy();
  });

  it("a closed issue is reference-only: sync uses state=all, but Start must disappear", async () => {
    stubIssues({ ...base, issues: [{ ...entry, state: "closed" }] });
    const { onStartIssue } = renderPanel();
    await waitFor(() => expect(screen.getByText("Fix the viewer list")).toBeTruthy());

    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.getByText(/Closed — not startable/)).toBeTruthy();
    expect(onStartIssue).not.toHaveBeenCalled();
  });

  it("re-reads the local snapshot when the issues view becomes visible again", async () => {
    const fetchMock = stubIssues(base);
    const { setVisible } = renderPanel();
    await waitFor(() => expect(screen.getByText("Fix the viewer list")).toBeTruthy());
    const firstCalls = fetchMock.mock.calls.length;

    // App keeps the panel mounted and only toggles visibility.
    setVisible(false);
    setVisible(true);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(firstCalls));
    // Silent reload: the already-rendered rows stay on screen, no spinner wipe.
    expect(screen.getByText("Fix the viewer list")).toBeTruthy();
  });
});
