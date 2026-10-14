// Pure keyboard-cycling order logic for the sidebar (Orca polish item 5):
// Cmd/Ctrl+Shift+ArrowUp/ArrowDown walks the rail's visible rows (pinned
// section first, then repo groups, same order the rail renders them),
// wrapping at either end. Kept free of React/DOM so the order/wrap math is
// unit-testable (see tests/sidebar-cycle.test.ts); Sidebar.tsx just flattens
// its on-screen rows into `taskIds` and calls this on the main-process
// `app:cycle-task` push.

export type CycleDirection = "up" | "down";

/**
 * The task id to focus next, cycling through `taskIds` (already in the
 * rail's visible top-to-bottom order) from `currentTaskId`. Wraps past
 * either end. Returns `undefined` for an empty list; returns `taskIds[0]`
 * when `currentTaskId` isn't present (nothing focused yet, or the focused
 * task scrolled out of the visible/filtered set).
 */
export function cycleTaskId(
  taskIds: readonly string[],
  currentTaskId: string | null,
  direction: CycleDirection,
): string | undefined {
  if (taskIds.length === 0) return undefined;
  const index = currentTaskId ? taskIds.indexOf(currentTaskId) : -1;
  if (index === -1) return taskIds[0];
  const delta = direction === "down" ? 1 : -1;
  const next = (index + delta + taskIds.length) % taskIds.length;
  return taskIds[next];
}
