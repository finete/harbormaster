// Pure "unread" transition logic for the sidebar/board unread emphasis
// (Orca polish item 7): a task becomes unread the moment its presence
// transitions `runningTurn: true -> false` ("finished while you weren't
// looking") while it is *not* the currently-focused task, or the app
// window itself isn't focused. Session-local only (never persisted) — kept
// here, free of React/DOM, so the transition rule itself is unit-testable
// without a browser (see tests/unread.test.ts). The owning hook
// (useUnreadTaskIds in core-client.ts) just calls this on every presence
// push and folds the result into a Set.

/** Minimal presence shape this module needs (matches `PresenceBadge`). */
export interface RunningPresence {
  runningTurn: boolean;
}

export interface UnreadTransitionInput {
  previous: Record<string, RunningPresence | undefined>;
  next: Record<string, RunningPresence | undefined>;
  /** The task currently shown in the workspace view, if any. */
  focusedTaskId: string | null;
  /** `document.hasFocus()` — an unfocused app window never counts as "looking". */
  windowFocused: boolean;
}

/**
 * Task ids that should be newly marked unread given a presence push. A task
 * already unread is not repeated here — the caller's Set union handles
 * idempotence — and a currently-focused, window-focused task is never
 * marked, matching Orca's "don't flag what you're already looking at" rule.
 */
export function unreadTransitions(input: UnreadTransitionInput): string[] {
  const { previous, next, focusedTaskId, windowFocused } = input;
  const marked: string[] = [];
  for (const taskId of Object.keys(next)) {
    const was = previous[taskId]?.runningTurn === true;
    const is = next[taskId]?.runningTurn === true;
    if (!was || is) continue; // only true -> false transitions count
    const looking = windowFocused && focusedTaskId === taskId;
    if (!looking) marked.push(taskId);
  }
  return marked;
}

/**
 * Applies a presence push to a previous unread set: adds any new
 * true->false transitions (for tasks not currently being looked at) and
 * clears the one task that just gained focus (if any) — the "cleared when
 * the task gains focus" half of the rule lives in `clearOnFocus` below since
 * it fires on focus changes, not presence pushes.
 */
export function applyUnreadTransition(
  current: ReadonlySet<string>,
  input: UnreadTransitionInput,
): Set<string> {
  const marked = unreadTransitions(input);
  if (marked.length === 0) return new Set(current);
  const next = new Set(current);
  for (const taskId of marked) next.add(taskId);
  return next;
}

/** Clears `taskId`'s unread flag (called when a task gains focus). No-op if absent (returns the same reference). */
export function clearUnread(
  current: ReadonlySet<string>,
  taskId: string,
): Set<string> {
  if (!current.has(taskId)) return new Set(current);
  const next = new Set(current);
  next.delete(taskId);
  return next;
}
