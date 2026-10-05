import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { Board } from "./components/Board";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceView } from "./components/WorkspaceView";
import { taskOrder } from "./mock";

type View = "board" | "workspace";

/**
 * Two top-level views, switched instantly (no router, see AGENTS.md):
 *
 * - "workspace" (default): sidebar listing every task + the focused task's
 *   per-task dockview terminal workspace (persists across switches).
 * - "board": the kanban board, full-width, reached via the sidebar's Board
 *   button, Cmd+B, or landing here from app start. Clicking a card jumps
 *   back into the workspace view focused on that task.
 */
export function App(): JSX.Element {
  const [view, setView] = useState<View>("workspace");
  const [focusedTaskId, setFocusedTaskId] = useState<string>(
    taskOrder[0] ?? "",
  );

  const selectTask = useCallback((taskId: string) => {
    setFocusedTaskId(taskId);
    setView("workspace");
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setView((current) => (current === "board" ? "workspace" : "board"));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-screen w-screen bg-background text-foreground">
      {view === "board" ? (
        <div data-testid="board-view" className="h-full w-full">
          <Board onSelectTask={selectTask} />
        </div>
      ) : (
        <div data-testid="workspace-view" className="flex h-full w-full">
          <Sidebar
            focusedTaskId={focusedTaskId}
            onSelectTask={selectTask}
            onShowBoard={() => setView("board")}
          />
          <WorkspaceView focusedTaskId={focusedTaskId} />
        </div>
      )}
    </div>
  );
}
