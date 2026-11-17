import { useCallback, useMemo, useRef, useState } from "react";

/** Result object passed to the action callback. */
export interface ActionApi {
  /** Record an error message; the dialog stays open and shows it. */
  fail: (message: string) => void;
  /** Mark the action finished successfully: the dialog closes. */
  done: () => void;
}

export function useActionDialog() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);

  const openDialog = useCallback(() => {
    setError("");
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    if (!lock.current) setOpen(false);
  }, []);

  /** Stable error setter, for pre-flight validation outside `run`. */
  const fail = useCallback((message: string) => setError(message), []);

  const run = useCallback(async (action: (api: ActionApi) => Promise<void>): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action({ fail: setError, done: () => setOpen(false) });
    } catch (err) {
      /* Network rejection must surface in the dialog, not as an unhandled rejection. */
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }, []);

  /* Stable identity keeps action-dependent useCallbacks from revalidating every poll. */
  return useMemo(() => ({ open, busy, error, fail, openDialog, close, run }), [open, busy, error, fail, openDialog, close, run]);
}
