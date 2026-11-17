import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useActionDialog } from "@/hooks/useActionDialog";

/* useActionDialog is the shared open/busy/error + re-entry lock behind every
 * run action (approve, reject, stop, message). The lock is what makes a
 * double-click on Approve harmless, so it deserves a runtime guard. */

function Harness({ action }: { action: (api: { fail: (m: string) => void; done: () => void }) => Promise<void> }) {
  const dialog = useActionDialog();
  const [clicks, setClicks] = useState(0);
  return (
    <div>
      <span data-testid="open">{String(dialog.open)}</span>
      <span data-testid="busy">{String(dialog.busy)}</span>
      <span data-testid="error">{dialog.error}</span>
      <span data-testid="clicks">{clicks}</span>
      <button onClick={() => { setClicks((c) => c + 1); void dialog.run(action); }}>run</button>
      <button onClick={dialog.close}>close</button>
      <button onClick={dialog.openDialog}>open</button>
    </div>
  );
}

describe("useActionDialog", () => {
  it("locks re-entry while the action is in flight", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(<Harness action={action} />);

    await user.click(screen.getByText("run"));
    expect(screen.getByTestId("busy").textContent).toBe("true");
    expect(action).toHaveBeenCalledTimes(1);

    /* Second click while busy must be ignored — the lock, not disabled props,
     * is the guarantee (the button is not even disabled). */
    await user.click(screen.getByText("run"));
    await user.click(screen.getByText("run"));
    expect(action).toHaveBeenCalledTimes(1);

    release?.();
    await waitFor(() => expect(screen.getByTestId("busy").textContent).toBe("false"));

    /* After the action finished the lock is released: the next click runs. */
    await user.click(screen.getByText("run"));
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("refuses to close mid-action and keeps the error on failure", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const action = vi.fn(
      (api: { fail: (m: string) => void }) =>
        new Promise<void>((resolve) => {
          release = () => {
            api.fail("boom");
            resolve();
          };
        }),
    );
    render(<Harness action={action} />);
    await user.click(screen.getByText("open"));
    await user.click(screen.getByText("run"));

    /* close() while busy is a no-op (the dialog must survive its action). */
    await user.click(screen.getByText("close"));
    expect(screen.getByTestId("open").textContent).toBe("true");

    release?.();
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("boom"));
  });
});
