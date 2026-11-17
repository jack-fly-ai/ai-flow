/* Single source of truth for viewer timing/limits that were previously scattered
 * as magic numbers across App and LiveLogPanel. Centralizing them makes the
 * polling cadence tunable and testable in one place. */

/** Runs list / run detail poll cadence (ms). */
export const RUN_POLL_INTERVAL_MS = 3000;

/** Live-log fallback poll cadence when SSE is unavailable (ms). */
export const LOG_POLL_INTERVAL_MS = 2000;

/** Cap on stream events rendered in the live log (the tail is what a reader needs). */
export const MAX_RENDERED_EVENTS = 400;

/** Consecutive EventSource errors tolerated before falling back to polling. */
export const SSE_MAX_ERRORS = 3;

/** Auto-dismiss duration for toasts (ms). */
export const TOAST_AUTO_DISMISS_MS = 6000;
