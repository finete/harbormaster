import { PanelLeft } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { Board } from "./components/Board";
import { Sidebar } from "./components/Sidebar";
import { Button } from "./components/ui/button";
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
        <div data-testid="board-view" className="flex h-full w-full flex-col">
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="workspace-button"
              onClick={() => setView("workspace")}
              title="Back to workspace (⌘B)"
            >
              <PanelLeft className="mr-1.5 h-4 w-4" />
              Workspace
            </Button>
            <span className="text-sm font-medium text-muted-foreground">
              Board
            </span>
            <span className="ml-auto text-xs text-muted-foreground">⌘B</span>
          </header>
          <div className="min-h-0 flex-1">
            <Board onSelectTask={selectTask} />
          </div>
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
