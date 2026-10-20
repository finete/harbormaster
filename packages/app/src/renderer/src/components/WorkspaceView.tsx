import type { JSX, ReactNode } from "react";
import { TaskWorkspace } from "./TaskWorkspace";

/**
 * Main area of the workspace view: holds one `TaskWorkspace` (dockview
 * instance) per task that has ever been focused, lazily created and never
 * torn down, so switching between tasks (or to the board and back) does not
 * kill running terminal sessions. Only the focused task's workspace is
 * visible; the rest are `display: none` but stay mounted.
 *
 * `openedTaskIds` is owned by `App.tsx` (not computed here) because the
 * takeover guard needs the same "has this task's pane already been opened by
 * this app" answer before it decides whether live presence needs a dialog.
 */
export function WorkspaceView({
  focusedTaskId,
  openedTaskIds,
  onCloseTask,
  composer = null,
}: {
  focusedTaskId: string;
  openedTaskIds: ReadonlySet<string>;
  onCloseTask: (taskId: string) => void;
  /**
   * The new-task composer while the draft row is focused. It takes the whole
   * pane (flat, no overlay); `focusedTaskId` is "" then, so every task
   * workspace is hidden but stays mounted.
   */
  composer?: ReactNode;
}): JSX.Element {
  if (openedTaskIds.size === 0) {
    if (composer) {
      return (
        <div data-testid="workspace-main" className="relative h-full flex-1">
          {composer}
        </div>
      );
    }
    return (
      <div data-testid="workspace-main" className="relative h-full flex-1">
        <div
          data-testid="workspace-empty-hint"
          className="flex h-full items-center justify-center text-sm text-muted-foreground"
        >
          No task selected — create or pick a task from the sidebar.
        </div>
      </div>
    );
  }

  return (
    <div data-testid="workspace-main" className="relative h-full flex-1">
      {Array.from(openedTaskIds).map((taskId) => (
        <div
          key={taskId}
          data-testid={`task-workspace-${taskId}`}
          className="absolute inset-0 h-full w-full"
          style={{ display: taskId === focusedTaskId ? "block" : "none" }}
        >
          <TaskWorkspace taskId={taskId} onClose={() => onCloseTask(taskId)} />
        </div>
      ))}
      {composer && <div className="absolute inset-0 z-10 flex">{composer}</div>}
    </div>
  );
}
