import { PanelLeft, RefreshCw } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PresenceSnapshot } from "../../preload/api";
import { Board } from "./components/Board";
import { ConfirmHost } from "./components/ConfirmHost";
import { ConnectivityBanner } from "./components/ConnectivityBanner";
import type { NewTaskDialogResult } from "./components/NewTaskDialog";
import { Sidebar } from "./components/Sidebar";
import { TakeoverDialog } from "./components/TakeoverDialog";
import { ToastHost } from "./components/ToastHost";
import { Button } from "./components/ui/button";
import { Dialog, DialogFooter } from "./components/ui/dialog";
import { Kbd } from "./components/ui/kbd";
import { WorkspaceView } from "./components/WorkspaceView";
import {
  flattenBoard,
  useBoard,
  useManualRefresh,
  useTaskNotifications,
  useUnreadTaskIds,
} from "./core-client";
import { isTypingTarget } from "./lib/keyboard-guard";
import { cn } from "./lib/utils";
import { describeThrown, pushToast } from "./toast";

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
  const getTaskTitle = useCallback(
    (taskId: string) => taskTitleRef.current.get(taskId) ?? "Task",
    [],
  );

  // OS notifications + dock badge (daily-driver switch, task B). Unread
  // state is still fully owned here through the same hook Sidebar/Board use
  // (see lib/unread.ts); this instance only ever feeds the dock badge count
  // and the `useTaskNotifications` subscription below "- it never renders
  // anything itself.
  const unreadTaskIds = useUnreadTaskIds(focusedTaskId);
  useEffect(() => {
    void window.harbormaster.app.setBadgeCount(unreadTaskIds.size);
  }, [unreadTaskIds]);
  useTaskNotifications(focusedTaskId, getTaskTitle);

  // Takeover-offer guard state (see /AGENTS.md "Attachment safety",
  // /docs/design-decisions.md #8, components/TakeoverDialog.tsx): set only
  // while a dialog is up for a task that turned out to be live elsewhere.
  const [takeover, setTakeover] = useState<{
    taskId: string;
    presence: PresenceSnapshot;
  } | null>(null);

  // Close-workspace confirm: set only while the focused task's agent is
  // mid-turn and the user asked to close its workspace anyway.
  const [pendingClose, setPendingClose] = useState<string | null>(null);

  // Cmd/Ctrl+N "open New Task dialog from either view" (board or workspace):
  // each view owns its own New Task dialog instance (Board.tsx / Sidebar.tsx),
  // so this just bumps whichever one is currently visible's open-signal —
  // never both, so only one `new-task-dialog` ever mounts at a time.
  const [boardNewTaskSignal, setBoardNewTaskSignal] = useState(0);
  const [sidebarNewTaskSignal, setSidebarNewTaskSignal] = useState(0);

  // Closing unmounts the TaskWorkspace, which disposes every pane's pty
  // (TerminalPane unmount cleanup); the pi session ends, cmux-style. The
  // task itself stays on the board; reopening starts fresh panes.
  const closeTask = useCallback((taskId: string) => {
    setOpenedTaskIds((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.delete(taskId);
      setFocusedTaskId((current) =>
        current === taskId ? (next.values().next().value ?? "") : current,
      );
      return next;
    });
  }, []);

  const requestCloseTask = useCallback(
    (taskId: string) => {
      void window.harbormaster.core.presence(taskId).then((presence) => {
        if (presence.live && presence.runningTurn) {
          setPendingClose(taskId);
          return;
        }
        closeTask(taskId);
      });
    },
    [closeTask],
  );

  // No auto-open on launch: opening a task spawns its pi session, and doing
  // that for whatever happens to sort first on the board meant every app
  // restart started an agent session nobody asked for. Launch lands on the
  // empty workspace hint; the user picks from the board or rail.

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

  // Shared "+ New task" handler for both entry points (Sidebar's footer
  // button, Board's header button): "Start now" auto-opens the new task's
  // workspace so it appears in the rail immediately, cmux-style; parked
  // backlog tasks stay off the rail until the user opens them explicitly
  // (a board card click or a sidebar row, once one exists). This never
  // focuses or switches view \u2014 only `selectTask`/`openTask` do that \u2014
  // so creating a task from the board keeps the board on screen.
  const createTask = useCallback((input: NewTaskDialogResult) => {
    void window.harbormaster.core
      .createTask({
        title: input.title,
        initialPrompt: input.initialPrompt ?? "",
        ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
        ...(input.start ? { start: true } : {}),
      })
      .then((task) => {
        if (!input.start) return;
        setOpenedTaskIds((prev) =>
          prev.has(task.id) ? prev : new Set(prev).add(task.id),
        );
      })
      .catch((error: unknown) => {
        console.error("createTask failed:", error);
        pushToast(describeThrown(error), "error");
      });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "b") {
        event.preventDefault();
        setView((current) => (current === "board" ? "workspace" : "board"));
        return;
      }
      if (key === "n") {
        // No dialog already open, and not mid-typing in some unrelated field
        // (see lib/keyboard-guard.ts) — matches the board's single-key guard.
        if (takeover || pendingClose) return;
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        if (view === "board") setBoardNewTaskSignal((count) => count + 1);
        else setSidebarNewTaskSignal((count) => count + 1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, takeover, pendingClose]);

  // Cmd/Ctrl+W, intercepted in main before Electron's menu can close the
  // window: close the focused task workspace while in the workspace view.
  useEffect(
    () =>
      window.harbormaster.core.onCloseTabShortcut(() => {
        if (view === "workspace" && focusedTaskId) {
          requestCloseTask(focusedTaskId);
        }
      }),
    [view, focusedTaskId, requestCloseTask],
  );

  // Clicking an OS notification: main pushes the clicked task's id (see
  // main/index.ts's `app:notify` click handler), reusing `selectTask` "- the
  // exact same guarded open/focus path a sidebar row or board card click
  // uses, same pattern as `app:cycle-task`.
  useEffect(
    () =>
      window.harbormaster.app.onOpenTask((taskId) => {
        selectTask(taskId);
        setView("workspace");
      }),
    [selectTask],
  );

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
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      {/* One sticky offline/reconnecting/restored strip above both views (see
          ConnectivityBanner): an environmental state, never a per-task
          warning toast. */}
      <ConnectivityBanner />
      <div className="flex min-h-0 flex-1">
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
                <Kbd>g</Kbd>
              </Button>
              <span className="text-sm font-medium text-muted-foreground">
                Board
              </span>
              <span className="ml-auto text-xs text-muted-foreground">⌘B</span>
            </header>
            <div className="min-h-0 flex-1">
              <Board
                onSelectTask={selectTask}
                onCreateTask={createTask}
                active={view === "board"}
                openNewTaskSignal={boardNewTaskSignal}
                onBackToWorkspace={() => setView("workspace")}
                focusedTaskId={focusedTaskId || null}
              />
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
              openedTaskIds={openedTaskIds}
              onSelectTask={selectTask}
              onCloseTask={requestCloseTask}
              onShowBoard={() => setView("board")}
              onCreateTask={createTask}
              openNewTaskSignal={sidebarNewTaskSignal}
            />
            <WorkspaceView
              focusedTaskId={focusedTaskId}
              openedTaskIds={openedTaskIds}
              onCloseTask={requestCloseTask}
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
        <Dialog
          open={pendingClose !== null}
          onOpenChange={(open) => {
            if (!open) setPendingClose(null);
          }}
          title="Agent is still working"
          testId="close-while-running-dialog"
        >
          <p className="text-sm text-muted-foreground">
            “
            {pendingClose
              ? (taskTitleRef.current.get(pendingClose) ?? "This task")
              : ""}
            ” has an agent mid-turn. Closing the workspace ends its session.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingClose(null)}
              data-testid="close-while-running-cancel"
            >
              Keep it running
            </Button>
            <Button
              variant="outline"
              className="border-red-900/60 text-red-400 hover:bg-red-950/40"
              data-testid="close-while-running-confirm"
              onClick={() => {
                if (pendingClose) closeTask(pendingClose);
                setPendingClose(null);
              }}
            >
              Close anyway
            </Button>
          </DialogFooter>
        </Dialog>
        <ToastHost />
        <ConfirmHost />
      </div>
    </div>
  );
}
