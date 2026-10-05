import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { TaskWorkspace } from "./TaskWorkspace";

/**
 * Main area of the workspace view: holds one `TaskWorkspace` (dockview
 * instance) per task that has ever been focused, lazily created and never
 * torn down, so switching between tasks (or to the board and back) does not
 * kill running terminal sessions. Only the focused task's workspace is
 * visible; the rest are `display: none` but stay mounted.
 */
export function WorkspaceView({
  focusedTaskId,
}: {
  focusedTaskId: string;
}): JSX.Element {
  const openedRef = useRef<Set<string>>(new Set());
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!openedRef.current.has(focusedTaskId)) {
      openedRef.current.add(focusedTaskId);
      forceRender((tick) => tick + 1);
    }
  }, [focusedTaskId]);

  return (
    <div data-testid="workspace-main" className="relative h-full flex-1">
      {Array.from(openedRef.current).map((taskId) => (
        <div
          key={taskId}
          data-testid={`task-workspace-${taskId}`}
          className="absolute inset-0 h-full w-full"
          style={{ display: taskId === focusedTaskId ? "block" : "none" }}
        >
          <TaskWorkspace taskId={taskId} />
        </div>
      ))}
    </div>
  );
}
