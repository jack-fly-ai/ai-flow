/* Run actions: the seven mutating operations the viewer can perform (start from
 * an issue, retry, approve, reject, stop, message, delete) plus the dialog state
 * each one drives. Kept out of App so the root component owns only session,
 * theme, view routing and keyboard shortcuts. Every mutation follows the same
 * shape: POST, inspect the body, report through the dialog (busy/error) or a
 * toast, then re-pull the query cache. */

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch, downloadBlob } from "@/lib/api";
import { useActionDialog } from "@/hooks/useActionDialog";
import { refreshAfterMutation } from "@/lib/queries";
import {
  LABELS,
  canApprove,
  canMessage,
  canRetry,
  canStop,
  isFailed,
  type ReworkStage,
  type RunDetail,
  type RunSummary,
  type Stage,
} from "@/lib/shared";

export interface Toast {
  kind: "success" | "error";
  text: string;
}

export interface UseRunActionsParams {
  selected: string | null;
  detail: RunDetail | null;
  runs: RunSummary[];
  selectRun: (id: string) => void;
  clearSelection: () => void;
  notify: (toast: Toast) => void;
}

export function useRunActions({ selected, detail, runs, selectRun, clearSelection, notify }: UseRunActionsParams) {
  const queryClient = useQueryClient();

  const [startingIssue, setStartingIssue] = useState<number | null>(null);
  const startLock = useRef(false);
  const [approveAnswer, setApproveAnswer] = useState("");
  const [rejectStage, setRejectStage] = useState<ReworkStage>("phase2");
  const [rejectComment, setRejectComment] = useState("");
  const [messageComment, setMessageComment] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const retryAction = useActionDialog();
  const approveAction = useActionDialog();
  const rejectAction = useActionDialog();
  const stopAction = useActionDialog();
  const messageAction = useActionDialog();
  const deleteAction = useActionDialog();

  const refresh = useCallback(async () => {
    await refreshAfterMutation(queryClient, selected);
  }, [queryClient, selected]);

  /* Opening an input dialog clears text from the previous run first, so a stale
   * reject comment or approve answer never leaks into the next action. */
  const openApprove = useCallback(() => {
    setApproveAnswer("");
    approveAction.openDialog();
  }, [approveAction]);
  const openReject = useCallback(() => {
    setRejectComment("");
    rejectAction.openDialog();
  }, [rejectAction]);
  const openMessage = useCallback(() => {
    setMessageComment("");
    messageAction.openDialog();
  }, [messageAction]);
  const openDeleteDialog = useCallback(
    (id: string) => {
      setDeleteTarget(id);
      deleteAction.openDialog();
    },
    [deleteAction],
  );

  /* The issue list is the single entry point for starting a run. The model is
   * omitted so the server uses the configured default; a busy lock prevents a
   * double-spawn from a fast double-click. */
  const startFromIssue = useCallback(
    async (number: number) => {
      if (startLock.current) return;
      startLock.current = true;
      setStartingIssue(number);
      try {
        const response = await apiFetch("/api/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: String(number) }),
        });
        const body = (await response.json().catch(() => ({ error: "Could not parse the response" }))) as {
          id?: string;
          error?: string;
          started?: boolean;
        };
        if (!response.ok) {
          notify({ kind: "error", text: body.error || `Failed to start (${response.status})` });
          return;
        }
        if (body.started === false) {
          notify({ kind: "error", text: body.error || "The run did not start. Check the agent command and its configuration." });
          return;
        }
        if (body.id) {
          selectRun(body.id);
          notify({ kind: "success", text: `${body.id} started` });
        }
        await refresh();
      } catch (err) {
        notify({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      } finally {
        startLock.current = false;
        setStartingIssue(null);
      }
    },
    [notify, refresh, selectRun],
  );

  const retryTask = useCallback(async () => {
    if (!selected || !detail || !isFailed(detail.state.status)) return;
    await retryAction.run(async ({ fail, done }) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const response = await apiFetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selected }),
      });
      const body = (await response.json().catch(() => ({ error: "Could not parse the response" }))) as {
        id?: string;
        error?: string;
        started?: boolean;
      };
      if (!response.ok) {
        fail(body.error || `Retry failed (${response.status})`);
        return;
      }
      if (body.started === false) {
        fail(body.error || "The run did not start. Check the agent command and its configuration.");
        return;
      }
      const stageName = LABELS[detail.state.stage as Stage] ?? detail.state.stage;
      done();
      notify({ kind: "success", text: `${selected} resumed from ${stageName}` });
      await refresh();
    });
  }, [selected, detail, retryAction, notify, refresh]);

  const approveTask = useCallback(async () => {
    /* reviewRun 409s on `state.rework` (an in-flight rework consumer). Do not
     * offer a second approve that the backend will reject. */
    if (!selected || !detail || !canApprove(detail.state)) return;
    const kind = detail.state.awaiting?.kind ?? "gate4";
    await approveAction.run(async ({ fail, done }) => {
      const response = await apiFetch(`/api/runs/${encodeURIComponent(selected)}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve", comment: approveAnswer.trim() }),
      });
      const body = (await response.json().catch(() => ({ error: "Could not parse the response" }))) as { error?: string };
      if (!response.ok) {
        fail(body.error || `Approve failed (${response.status})`);
        return;
      }
      done();
      if (kind === "gate4") {
        // Header-based download keeps the token out of the URL query string.
        void downloadBlob(`/api/runs/${encodeURIComponent(selected)}/patch`).catch((err: unknown) => {
          notify({
            kind: "error",
            text: `Approved, but the patch download failed (${err instanceof Error ? err.message : String(err)}). It remains in the run directory.`,
          });
        });
        notify({ kind: "success", text: `${selected} approved (gate 4). The patch downloads started — apply it to submit the change.` });
      } else {
        notify({ kind: "success", text: `${selected} continues with your answer injected.` });
      }
      await refresh();
    });
  }, [selected, detail, approveAction, approveAnswer, notify, refresh]);

  const rejectTask = useCallback(async () => {
    if (!selected || !detail || !canApprove(detail.state)) return;
    const comment = rejectComment.trim();
    if (!comment) {
      rejectAction.fail("Enter a comment");
      return;
    }
    await rejectAction.run(async ({ fail, done }) => {
      const response = await apiFetch(`/api/runs/${encodeURIComponent(selected)}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject", stage: rejectStage, comment }),
      });
      const body = (await response.json().catch(() => ({ error: "Could not parse the response" }))) as { error?: string };
      if (!response.ok) {
        fail(body.error || `Reject failed (${response.status})`);
        return;
      }
      const stageName = LABELS[rejectStage];
      done();
      setRejectComment("");
      notify({ kind: "success", text: `${selected} will rerun from ${stageName}` });
      await refresh();
    });
  }, [selected, detail, rejectAction, rejectComment, rejectStage, notify, refresh]);

  const stopTask = useCallback(async () => {
    if (!selected) return;
    await stopAction.run(async ({ done }) => {
      const response = await apiFetch(`/api/runs/${encodeURIComponent(selected)}/stop`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        // StopDialog has no error slot; surface via toast, dialog stays open.
        notify({ kind: "error", text: body.error || `Stop failed (${response.status})` });
        return;
      }
      done();
      notify({ kind: "success", text: `${selected} stopped. Retry resumes from the interrupted stage; Delete removes it.` });
      await refresh();
    });
  }, [selected, stopAction, notify, refresh]);

  const messageTask = useCallback(async () => {
    if (!selected || !detail || !isFailed(detail.state.status)) return;
    const comment = messageComment.trim();
    if (!comment) {
      messageAction.fail("Enter a message");
      return;
    }
    await messageAction.run(async ({ fail, done }) => {
      const response = await apiFetch(`/api/runs/${encodeURIComponent(selected)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; resumedFrom?: string };
      if (!response.ok) {
        fail(body.error || `Message failed (${response.status})`);
        return;
      }
      const stageName = body.resumedFrom ?? detail.state.stage;
      done();
      setMessageComment("");
      notify({ kind: "success", text: `Message sent; run resumed from ${stageName}` });
      await refresh();
    });
  }, [selected, detail, messageAction, messageComment, notify, refresh]);

  const deleteTask = useCallback(async () => {
    if (!deleteTarget) return;
    await deleteAction.run(async ({ fail, done }) => {
      const response = await apiFetch(`/api/runs/${encodeURIComponent(deleteTarget)}`, { method: "DELETE" });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        fail(body.error || `Delete failed (${response.status})`);
        return;
      }
      const removed = deleteTarget;
      done();
      setDeleteTarget(null);
      /* Keep the reviewer in the flow: after deleting the open run, jump to a
       * neighbor in the current list instead of dropping to "select a run". */
      const removedIdx = runs.findIndex((run) => run.id === removed);
      const remaining = runs.filter((run) => run.id !== removed);
      const nextId = remaining.length > 0 ? remaining[Math.min(removedIdx, remaining.length - 1)].id : null;
      if (removed === selected) {
        if (nextId) selectRun(nextId);
        else clearSelection();
      }
      notify({ kind: "success", text: `${removed} deleted` });
      await refresh();
    });
  }, [deleteTarget, deleteAction, selected, runs, selectRun, clearSelection, notify, refresh]);

  const deleteRunSummary = deleteTarget ? runs.find((run) => run.id === deleteTarget) : undefined;
  const failedStageLabel = LABELS[detail?.state.stage as Stage] ?? detail?.state.stage ?? "the failed stage";

  return {
    startingIssue,
    approveAnswer,
    setApproveAnswer,
    rejectStage,
    setRejectStage,
    rejectComment,
    setRejectComment,
    messageComment,
    setMessageComment,
    deleteTarget,
    deleteRunSummary,
    failedStageLabel,
    retryAction,
    approveAction,
    rejectAction,
    stopAction,
    messageAction,
    deleteAction,
    openApprove,
    openReject,
    openMessage,
    openDeleteDialog,
    startFromIssue,
    retryTask,
    approveTask,
    rejectTask,
    stopTask,
    messageTask,
    deleteTask,
  };
}
