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
import { modKeyLabel } from "./lib/platform";
import { useSidebarOrder } from "./lib/use-sidebar-order";
import { cn } from "./lib/utils";
import {
  readFocusedTaskId,
  readOpenedTaskIds,
  removeWorkspaceLayout,
  storeFocusedTaskId,
  storeOpenedTaskIds,
} from "./lib/workspace-persistence";
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
  const sidebarOrder = useSidebarOrder();
  const { appendOpened, removeClosed } = sidebarOrder;
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
  // task itself stays on the board; reopening starts fresh panes. Also
  // drops the task's persisted dockview layout (lib/workspace-persistence)
  // so a later reopen never resurrects a stale one — relaunching after a
  // close must not restore it (restore only replays what was open at exit).
  const closeTask = useCallback(
    (taskId: string) => {
      setOpenedTaskIds((prev) => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        setFocusedTaskId((current) =>
          current === taskId ? (next.values().next().value ?? "") : current,
        );
        return next;
      });
      removeWorkspaceLayout(window.localStorage, taskId);
      // The single close path: forget the task's rail position (and detached
      // flag) so a reopen lands at the bottom. Never runs during startup
      // restore, which only ever *adds* to openedTaskIds.
      removeClosed(taskId);
    },
    [removeClosed],
  );

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

  // No auto-open *by board order* on launch: opening a task spawns its pi
  // session, and doing that for whatever happens to sort first on the board
  // meant every app restart started an agent session nobody asked for.
  // Restoring the *previously open* rail (below) is a different thing: it
  // only reopens tasks the user had already opened before the app went
  // away, same set, same focus "- an iTerm-style window restore, not an
  // arbitrary auto-pick.

  // Restore-on-launch (task A): reopens the rail tab + focus set persisted
  // by the effects further down. Runs once; waits for `listBoard` directly
  // (not `useBoard`'s own fetch above) so filtering against *current* tasks
  // never races a still-empty `columns` on first render "- deleted/archived
  // tasks are silently dropped from the restored set here.
  //
  // Restored tasks are opened directly into `openedTaskIds`, bypassing
  // `selectTask`'s presence check entirely: this is safe *because* it is
  // restore, not a fresh pick "- any record that was open in an app that no
  // longer exists is either this exact app's own now-dead pane (no takeover
  // possible, nothing to attach to) or a genuinely external session, for
  // which opening a plain viewer pane is still the correct outcome, not an
  // error. Either way there is no live "this app already owns it" conflict
  // to dialog about "- that guard exists for *other* surfaces racing this
  // app's live panes, not for this app reopening its own dead ones.
  const [restoreComplete, setRestoreComplete] = useState(false);
  // Deliberate run-once-at-mount effect, before any user action can touch
  // openedTaskIds/focusedTaskId.
  useEffect(() => {
    let cancelled = false;
    const storage = window.localStorage;
    const savedOpened = readOpenedTaskIds(storage);
    if (savedOpened.size === 0) {
      setRestoreComplete(true);
      return;
    }
    const savedFocused = readFocusedTaskId(storage);
    // The board fetch can fail or stall during a heavy boot (dependency
    // re-optimization reloads, core still initializing). A single unguarded
    // attempt once left restoreComplete false for the whole session: nothing
    // restored AND nothing persisted. Retry with backoff; never give up on
    // the saved set, and never let live persistence stay disabled.
    const attempt = (tryNumber: number): void => {
      Promise.race([
        window.harbormaster.core.listBoard(),
        new Promise<never>((_, reject) =>
          window.setTimeout(
            () => reject(new Error("listBoard timed out")),
            10_000,
          ),
        ),
      ])
        .then((cols) => {
          if (cancelled) return;
          const known = new Set(flattenBoard(cols).map((row) => row.task.id));
          const restored = new Set(
            [...savedOpened].filter((id) => known.has(id)),
          );
          if (restored.size > 0) {
            setOpenedTaskIds(restored);
            setFocusedTaskId(
              savedFocused && restored.has(savedFocused)
                ? savedFocused
                : (restored.values().next().value ?? ""),
            );
          }
          setRestoreComplete(true);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          console.error(
            `workspace restore: listBoard failed (try ${tryNumber}):`,
            error,
          );
          window.setTimeout(
            () => {
              if (!cancelled) attempt(tryNumber + 1);
            },
            Math.min(500 * 2 ** tryNumber, 5000),
          );
        });
    };
    attempt(0);
    return () => {
      cancelled = true;
    };
  }, []);

  // Live persistence (task A item 3): the open set, focus, and layout must
  // reflect current state at all times, not just on a clean shutdown "- the
  // app can be SIGKILLed by launchctl kickstart with no exit hook to flush
  // from. Gated on `restoreComplete` so the empty initial state never
  // clobbers a just-read saved set before restoration has had a chance to
  // apply it.
  useEffect(() => {
    if (!restoreComplete) return;
    storeOpenedTaskIds(window.localStorage, openedTaskIds);
  }, [restoreComplete, openedTaskIds]);
  useEffect(() => {
    if (!restoreComplete) return;
    storeFocusedTaskId(window.localStorage, focusedTaskId);
  }, [restoreComplete, focusedTaskId]);

  const openTask = useCallback(
    (taskId: string) => {
      setFocusedTaskId(taskId);
      setOpenedTaskIds((prev) =>
        prev.has(taskId) ? prev : new Set(prev).add(taskId),
      );
      // A task not yet in the stored rail order appends at the bottom.
      appendOpened(taskId);
      setView("workspace");
    },
    [appendOpened],
  );

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
  const createTask = useCallback(
    (input: NewTaskDialogResult) => {
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
          appendOpened(task.id);
        })
        .catch((error: unknown) => {
          console.error("createTask failed:", error);
          pushToast(describeThrown(error), "error");
        });
    },
    [appendOpened],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // On macOS, app shortcuts require Cmd (metaKey), not Ctrl — Ctrl belongs
      // to the pty (tmux prefix, cursor motion, etc.).
      const isMac = /mac/i.test(navigator.platform);
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (!mod) return;
      // Guard: don't fire when the other platform modifier is held alone
      // (e.g. Ctrl on mac — let it reach the pty).
      if (isMac && event.ctrlKey && !event.metaKey) return;
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
            <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                data-testid="workspace-button"
                onClick={() => setView("workspace")}
                title={`Back to workspace (${modKeyLabel()}B)`}
              >
                <PanelLeft className="mr-1.5 h-3.5 w-3.5" />
                Workspace
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                data-testid="board-refresh-button"
                aria-busy={manualRefresh.busy}
                disabled={manualRefresh.busy}
                onClick={manualRefresh.refresh}
                title="Refresh PR status and run movers now (g)"
              >
                <RefreshCw
                  className={cn(
                    "mr-1.5 h-3.5 w-3.5",
                    manualRefresh.busy && "animate-spin",
                  )}
                />
                Refresh
              </Button>
              <span className="px-1 text-sm font-medium text-muted-foreground">
                Board
              </span>
              <Button
                size="sm"
                className="ml-auto h-7 px-2"
                data-testid="board-new-task-button"
                onClick={() => setBoardNewTaskSignal((n) => n + 1)}
              >
                + New task
                <Kbd>{`${modKeyLabel()}N`}</Kbd>
              </Button>
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
              taskOrder={sidebarOrder.taskOrder}
              onTaskOrderChange={sidebarOrder.setTaskOrder}
              detachedIds={sidebarOrder.detachedIds}
              onDetachedChange={sidebarOrder.setDetachedIds}
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
