import { PanelLeft, RefreshCw } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PresenceSnapshot } from "../../preload/api";
import { Board } from "./components/Board";
import { Sidebar } from "./components/Sidebar";
import { TakeoverDialog } from "./components/TakeoverDialog";
import { ToastHost } from "./components/ToastHost";
import { Button } from "./components/ui/button";
import { WorkspaceView } from "./components/WorkspaceView";
import { flattenBoard, useBoard, useManualRefresh } from "./core-client";
import { cn } from "./lib/utils";
import { pushToast } from "./toast";

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
  const [focusedTaskId, setFocusedTaskId] = useState<string>("");
  const [openedTaskIds, setOpenedTaskIds] = useState<Set<string>>(new Set());
  const columns = useBoard();
  const manualRefresh = useManualRefresh();
  const flatRows = useMemo(() => flattenBoard(columns), [columns]);
  const taskTitleRef = useRef<Map<string, string>>(new Map());
  for (const { task } of flatRows)
    taskTitleRef.current.set(task.id, task.title);

  // Takeover-offer guard state (see /AGENTS.md "Attachment safety",
  // /docs/design-decisions.md #8, components/TakeoverDialog.tsx): set only
  // while a dialog is up for a task that turned out to be live elsewhere.
  const [takeover, setTakeover] = useState<{
    taskId: string;
    presence: PresenceSnapshot;
  } | null>(null);

  // Default focus to the first task once the board has loaded, same as the
  // old mock's `taskOrder[0]` default — but only once: never yank focus
  // away from a task the user picked (or that got created) later.
  useEffect(() => {
    if (!focusedTaskId && flatRows.length > 0) {
      const firstId = flatRows[0]?.task.id ?? "";
      setFocusedTaskId(firstId);
      if (firstId) {
        setOpenedTaskIds((prev) => new Set(prev).add(firstId));
      }
    }
  }, [focusedTaskId, flatRows]);

  const openTask = useCallback((taskId: string) => {
    setFocusedTaskId(taskId);
    setOpenedTaskIds((prev) =>
      prev.has(taskId) ? prev : new Set(prev).add(taskId),
    );
    setView("workspace");
  }, []);

  // Entry point for every "open/focus this task" action (sidebar row, board
  // card). Own-pane-live tasks (already in `openedTaskIds`) just focus, no
  // dialog "-" the pane guards its own pty, nothing to double-attach. A task
  // this app has never opened gets a presence check first; live-and-not-ours
  // routes through the takeover dialog before ever mounting its pane.
  const selectTask = useCallback(
    (taskId: string) => {
      if (openedTaskIds.has(taskId)) {
        openTask(taskId);
        return;
      }
      void window.harbormaster.core.presence(taskId).then((presence) => {
        if (presence.live && !presence.ownedByApp) {
          setTakeover({ taskId, presence });
          return;
        }
        openTask(taskId);
      });
    },
    [openedTaskIds, openTask],
  );

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

  // Main's 30s automation-refresh loop (see main/index.ts's refreshOnce)
  // pushes at most one deduped warning per distinct failure; surface it the
  // same way any task-action error does.
  useEffect(
    () =>
      window.harbormaster.core.onRefreshWarning((warning) => {
        pushToast(warning, "warning");
      }),
    [],
  );

  return (
    <div className="flex h-screen w-screen bg-background text-foreground">
      {/* Both views stay mounted; hiding via CSS keeps every TaskWorkspace
          (and its pty-backed terminals) alive across board/workspace switches. */}
      {
        <div
          data-testid="board-view"
          className={
            view === "board" ? "flex h-full w-full flex-col" : "hidden"
          }
        >
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="workspace-button"
              onClick={() => setView("workspace")}
              title="Back to workspace"
            >
              <PanelLeft className="mr-1.5 h-4 w-4" />
              Workspace
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="board-refresh-button"
              aria-busy={manualRefresh.busy}
              disabled={manualRefresh.busy}
              onClick={manualRefresh.refresh}
              title="Refresh PR status and run movers now"
            >
              <RefreshCw
                className={cn(
                  "mr-1.5 h-4 w-4",
                  manualRefresh.busy && "animate-spin",
                )}
              />
              Refresh
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
      }
      {
        <div
          data-testid="workspace-view"
          className={view === "workspace" ? "flex h-full w-full" : "hidden"}
        >
          <Sidebar
            focusedTaskId={focusedTaskId}
            onSelectTask={selectTask}
            onShowBoard={() => setView("board")}
          />
          <WorkspaceView
            focusedTaskId={focusedTaskId}
            openedTaskIds={openedTaskIds}
          />
        </div>
      }
      <TakeoverDialog
        open={takeover !== null}
        taskTitle={
          takeover ? (taskTitleRef.current.get(takeover.taskId) ?? "") : ""
        }
        presence={takeover?.presence ?? null}
        onCancel={() => setTakeover(null)}
        onAttachAnyway={() => {
          if (!takeover) return;
          const { taskId } = takeover;
          setTakeover(null);
          openTask(taskId);
        }}
      />
      <ToastHost />
    </div>
  );
}
