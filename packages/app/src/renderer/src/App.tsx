import { PanelLeft, RefreshCw } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PresenceSnapshot } from "../../preload/api";
import {
  ApprovalInboxButton,
  ApprovalInboxSheet,
} from "./components/ApprovalInbox";
import { Board } from "./components/Board";
import { ConfirmHost } from "./components/ConfirmHost";
import { ConnectivityBanner } from "./components/ConnectivityBanner";
import {
  NewTaskComposer,
  type NewTaskOutcome,
} from "./components/NewTaskComposer";
import { Sidebar } from "./components/Sidebar";
import { TakeoverDialog } from "./components/TakeoverDialog";
import { ToastHost } from "./components/ToastHost";
import { Button } from "./components/ui/button";
import { Kbd } from "./components/ui/kbd";
import { WorkspaceView } from "./components/WorkspaceView";
import { requestConfirm } from "./confirm";
import {
  flattenBoard,
  useBoard,
  useManualRefresh,
  useTaskNotifications,
  useUnreadTaskIds,
} from "./core-client";
import { isTypingTarget } from "./lib/keyboard-guard";
import {
  draftLabel,
  emptyDraft,
  isDraftEmpty,
  type NewTaskDraft,
  type NewTaskPrefs,
  readDraft,
  readPrefs,
  rememberDraft,
  storeDraft,
  storePrefs,
} from "./lib/new-task-draft";
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
/** How often the renderer re-runs the (slow, `du`-backed) orphan-worktree scan. */
const ORPHAN_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function App(): JSX.Element {
  const [view, setView] = useState<View>("workspace");
  // The approval inbox sheet (components/ApprovalInbox.tsx): one instance,
  // opened from the header button of whichever view is showing.
  const [inboxOpen, setInboxOpen] = useState(false);
  const [focusedTaskId, setFocusedTaskId] = useState<string>("");
  const [openedTaskIds, setOpenedTaskIds] = useState<Set<string>>(new Set());
  const sidebarOrder = useSidebarOrder();
  const { appendOpened, prependOpened, removeClosed } = sidebarOrder;
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

  // The new-task DRAFT (renderer-only, persisted; lib/new-task-draft.ts):
  // at most one. While `draftFocused` the main pane shows the composer and no
  // task is "visible" (`focusedTaskId` is kept as the task to fall back to).
  const [draft, setDraft] = useState<NewTaskDraft | null>(() =>
    readDraft(window.localStorage),
  );
  const [draftFocused, setDraftFocused] = useState(false);
  const [draftFocusSignal, setDraftFocusSignal] = useState(0);
  useEffect(() => {
    storeDraft(window.localStorage, draft);
  }, [draft]);
  // Sticky composer choices (last Where / agent / model, recent Wheres).
  const [newTaskPrefs, setNewTaskPrefs] = useState<NewTaskPrefs>(() =>
    readPrefs(window.localStorage),
  );
  const visibleTaskId = draftFocused ? "" : focusedTaskId;
  const boardTasks = useMemo(() => flatRows.map((row) => row.task), [flatRows]);
  const draftOrigin = draft?.originTaskId
    ? (boardTasks.find((task) => task.id === draft.originTaskId) ?? null)
    : null;

  // OS notifications + dock badge (daily-driver switch, task B). Unread
  // state is still fully owned here through the same hook Sidebar/Board use
  // (see lib/unread.ts); this instance only ever feeds the dock badge count
  // and the `useTaskNotifications` subscription below "- it never renders
  // anything itself.
  const unreadTaskIds = useUnreadTaskIds(visibleTaskId);
  useEffect(() => {
    void window.harbormaster.app.setBadgeCount(unreadTaskIds.size);
  }, [unreadTaskIds]);
  useTaskNotifications(visibleTaskId, getTaskTitle);

  // Takeover-offer guard state (see /AGENTS.md "Attachment safety",
  // /docs/design-decisions.md #8, components/TakeoverDialog.tsx): set only
  // while a dialog is up for a task that turned out to be live elsewhere.
  const [takeover, setTakeover] = useState<{
    taskId: string;
    presence: PresenceSnapshot;
  } | null>(null);

  // Close-workspace confirm: set only while the focused task's agent is
  // mid-turn and the user asked to close its workspace anyway.

  // Closing unmounts the TaskWorkspace. Its "+ terminal" shells are killed,
  // but the task's pi keeps running in the background (TerminalPane
  // releases it; main keeps the few most recently closed warm, see
  // main/warm-sessions.ts), so reopening re-attaches instantly and closing
  // never interrupts a working agent. The task stays on the board. Also
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
            // Merge, never replace: a launch that auto-opened while the
            // board fetch was in flight (onTaskLaunched below) must survive.
            setOpenedTaskIds((prev) => new Set([...restored, ...prev]));
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
      setDraftFocused(false);
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

  // The ONE way to create a task (Cmd/Ctrl+N, the sidebar button, the board
  // header button): leave the board, then open/focus THE draft. An existing
  // draft is only focused; a fresh one captures the focused task as its
  // origin (the task a launch would come from).
  const openDraft = useCallback(() => {
    const origin = focusedTaskId
      ? (boardTasks.find((task) => task.id === focusedTaskId) ?? {
          id: focusedTaskId,
        })
      : null;
    setDraft((prev) => prev ?? emptyDraft(origin, newTaskPrefs));
    setDraftFocused(true);
    setDraftFocusSignal((count) => count + 1);
    setView("workspace");
  }, [focusedTaskId, boardTasks, newTaskPrefs]);

  const discardDraft = useCallback(() => {
    setDraft(null);
    setDraftFocused(false);
  }, []);

  const closeDraft = useCallback(() => {
    if (!draft || isDraftEmpty(draft)) {
      discardDraft();
      return;
    }
    void requestConfirm({
      title: "Discard draft?",
      message: "This new task draft has content that will be lost.",
      confirmLabel: "Discard",
    }).then((confirmed) => {
      if (confirmed) discardDraft();
    });
  }, [draft, discardDraft]);

  // A submitted draft. "Start" turns the draft row into the real task in the
  // same place (top of the rail) and focuses it - it is our own fresh task, so
  // no takeover check. Park/background return focus to the origin task:
  // launching never steals focus (/docs/design-decisions.md "Launching tasks
  // from an agent"). The draft's choices become the next draft's defaults.
  const onDraftSubmitted = useCallback(
    (outcome: NewTaskOutcome) => {
      const originId = draft?.originTaskId ?? null;
      if (draft) {
        const prefs = rememberDraft(newTaskPrefs, draft);
        setNewTaskPrefs(prefs);
        storePrefs(window.localStorage, prefs);
      }
      setDraft(null);
      setDraftFocused(false);
      if (outcome.action === "start") {
        const id = outcome.task.id;
        setOpenedTaskIds((prev) =>
          prev.has(id) ? prev : new Set(prev).add(id),
        );
        prependOpened(id);
        setFocusedTaskId(id);
        return;
      }
      if (originId && openedTaskIds.has(originId)) setFocusedTaskId(originId);
      pushToast(
        outcome.action === "background"
          ? `Launched ${outcome.task.title} \u2014 queued`
          : `Parked ${outcome.task.title} in Backlog`,
        "success",
      );
    },
    [draft, newTaskPrefs, openedTaskIds, prependOpened],
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
        if (takeover) return;
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        openDraft();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [takeover, openDraft]);

  // Cmd/Ctrl+W, intercepted in main before Electron's menu can close the
  // window: close the focused task workspace while in the workspace view.
  useEffect(
    () =>
      window.harbormaster.core.onCloseTabShortcut(() => {
        if (view !== "workspace") return;
        if (draftFocused) closeDraft();
        else if (focusedTaskId) closeTask(focusedTaskId);
      }),
    [view, draftFocused, focusedTaskId, closeTask, closeDraft],
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

  // A launched task (agent tool or the composer's launch mode) whose
  // background session just started: add it to the rail so it is one click
  // away, but never steal focus or the view (/docs/design-decisions.md
  // "Launching tasks from an agent"). Main pushes this only once the pty
  // exists, so the pane that mounts here attaches to it (no takeover check:
  // it is our own app-owned session). Only focuses when nothing else is.
  useEffect(
    () =>
      window.harbormaster.app.onTaskLaunched((taskId) => {
        setOpenedTaskIds((prev) =>
          prev.has(taskId) ? prev : new Set(prev).add(taskId),
        );
        appendOpened(taskId);
        setFocusedTaskId((current) => current || taskId);
      }),
    [appendOpened],
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

  // Orphaned worktrees (no task owns them) silently filled the disk once;
  // scan at startup and every few hours, and say so once it crosses the
  // threshold (core decides). Never deletes anything: the toast only opens
  // the folder.
  useEffect(() => {
    const scan = () => {
      window.harbormaster.core
        .scanOrphanWorktrees()
        .then((report) => {
          if (!report.warning) return;
          pushToast(report.warning, "warning", {
            label: "Show in Finder",
            run: () => {
              void window.harbormaster.shell.revealInFolder(report.root);
            },
          });
        })
        .catch(() => {});
    };
    scan();
    const timer = setInterval(scan, ORPHAN_SCAN_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

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
              <div className="ml-auto flex items-center gap-2">
                <ApprovalInboxButton
                  testId="board-approval-inbox-button"
                  onClick={() => setInboxOpen(true)}
                />
                <Button
                  size="sm"
                  className="h-7 px-2"
                  data-testid="board-new-task-button"
                  onClick={openDraft}
                >
                  + New task
                  <Kbd>{`${modKeyLabel()}N`}</Kbd>
                </Button>
              </div>
            </header>
            <div className="min-h-0 flex-1">
              <Board
                onSelectTask={selectTask}
                onNewTask={openDraft}
                active={view === "board"}
                onBackToWorkspace={() => setView("workspace")}
                focusedTaskId={visibleTaskId || null}
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
              focusedTaskId={visibleTaskId}
              openedTaskIds={openedTaskIds}
              taskOrder={sidebarOrder.taskOrder}
              onTaskOrderChange={sidebarOrder.setTaskOrder}
              detachedIds={sidebarOrder.detachedIds}
              onDetachedChange={sidebarOrder.setDetachedIds}
              onSelectTask={selectTask}
              onCloseTask={closeTask}
              onShowBoard={() => setView("board")}
              onOpenApprovals={() => setInboxOpen(true)}
              onNewTask={openDraft}
              draftLabel={draft ? draftLabel(draft) : null}
              draftFocused={draftFocused}
              onSelectDraft={() => {
                setDraftFocused(true);
                setDraftFocusSignal((count) => count + 1);
              }}
              onCloseDraft={closeDraft}
            />
            <WorkspaceView
              focusedTaskId={visibleTaskId}
              openedTaskIds={openedTaskIds}
              onCloseTask={closeTask}
              composer={
                draft && draftFocused ? (
                  <NewTaskComposer
                    draft={draft}
                    onChange={(patch) =>
                      setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
                    }
                    origin={draftOrigin}
                    tasks={boardTasks}
                    recents={newTaskPrefs.recents}
                    focusSignal={draftFocusSignal}
                    onSubmitted={onDraftSubmitted}
                  />
                ) : null
              }
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
        <ApprovalInboxSheet open={inboxOpen} onOpenChange={setInboxOpen} />
        <ToastHost />
        <ConfirmHost />
      </div>
    </div>
  );
}
