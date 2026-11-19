// Closing a live review tab closes its Plannotator session
// (docs/plannotator.md decision 9). An explicit close (the tab's ×, closing
// the task's workspace with Cmd/Ctrl+W, the header ✕ or the sidebar row's ✕,
// and Done) asks main to end the session the way Plannotator's own Close
// does, so the agent hears "closed without feedback" instead of waiting on
// a review nobody can reach any more. That discards the draft, so it asks
// first when the draft holds unsent comments. App quit, hiding the
// workspace or switching tabs never close anything.

import { requestConfirm } from "../confirm";

/** Each mounted task workspace's live review URL, read at close time. */
const reviewSources = new Map<string, () => string | undefined>();

/** TaskWorkspace registers how to read its review tab's URL; returns the unregister. */
export function registerReviewSource(
  taskId: string,
  readUrl: () => string | undefined,
): () => void {
  reviewSources.set(taskId, readUrl);
  return () => {
    if (reviewSources.get(taskId) === readUrl) reviewSources.delete(taskId);
  };
}

/** The task's review session URL, when its workspace is open with one. */
export function reviewUrlFor(taskId: string): string | undefined {
  return reviewSources.get(taskId)?.();
}

function comments(count: number): string {
  return `${count} review comment${count === 1 ? "" : "s"}`;
}

/** The question before closing a review that has unsent comments. */
export function closeReviewQuestion(unsent: number): {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
} {
  return {
    title: "Close review?",
    message: `${comments(unsent)} not sent. They'll be lost if you close.`,
    confirmLabel: "Close review",
    cancelLabel: "Keep open",
  };
}

/** Done's extra line when the task's review has unsent comments. */
export function doneLosesCommentsLine(unsent: number): string {
  return `${comments(unsent)} not sent will be lost (the review closes).`;
}

/** Unsent comments in a review; 0 for no review or a server that's gone. */
export async function unsentReviewComments(
  url: string | undefined,
): Promise<number> {
  if (!url) return 0;
  try {
    return (await window.harbormaster.core.countUnsentReviewComments(url)) ?? 0;
  } catch {
    return 0;
  }
}

/** Ends the session; a server that's already gone is fine. */
export async function endReviewSession(url: string | undefined): Promise<void> {
  if (!url) return;
  try {
    await window.harbormaster.core.closeReviewSession(url);
  } catch {
    // Nothing to close.
  }
}

/**
 * The explicit-close path: asks only when unsent comments would be lost,
 * then ends the session. `false` = the user kept the review open (the
 * caller must not close the tab or workspace).
 */
export async function closeReview(url: string | undefined): Promise<boolean> {
  if (!url) return true;
  const unsent = await unsentReviewComments(url);
  if (unsent > 0 && !(await requestConfirm(closeReviewQuestion(unsent)))) {
    return false;
  }
  await endReviewSession(url);
  return true;
}
