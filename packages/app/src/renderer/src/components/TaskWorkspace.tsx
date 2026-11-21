import {
  type DockviewApi,
  type DockviewGroupPanel,
  DockviewReact,
  type DockviewReadyEvent,
} from "dockview-react";
import type { JSX } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import "dockview-react/dist/styles/dockview.css";
import { RefreshCw, X } from "lucide-react";
import type { TaskState } from "../../../preload/api";
import { flattenBoard, useBoard, useManualRefresh } from "../core-client";
import { modKeyLabel } from "../lib/platform";
import { registerWorkspaceFocus } from "../lib/renderer-diagnostics";
import { registerReviewSource } from "../lib/review-close";
import {
  reviewPanelId,
  type TaskUrlOpen,
  taskUrls,
  useTaskUrls,
} from "../lib/task-urls";
import { defaultTerminalTitle } from "../lib/terminal-title";
import { cn } from "../lib/utils";
import {
  readWorkspaceLayout,
  storeWorkspaceLayout,
  withLivePrimaryCwd,
} from "../lib/workspace-persistence";
import { makeGroupHeaderActions } from "./GroupHeaderActions";
import { OpenInButton } from "./OpenInButton";
import { ResumeTaskCard } from "./ResumeTaskCard";
import { SidebarRevealButton } from "./SidebarReveal";
import { TaskActions } from "./TaskActions";
import { TaskAudit } from "./TaskAudit";
import { TaskUsageChip } from "./TaskUsageChip";
import { TerminalPane } from "./TerminalPane";
import { TerminalTab } from "./TerminalTab";
import { UrlPane, type UrlPanelParams } from "./UrlPane";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

const components = {
  terminal: TerminalPane,
  url: UrlPane,
};

const tabComponents = {
  terminal: TerminalTab,
  url: TerminalTab,
};

let nextPanelId = 1;

/**
 * A click in the unoccupied area right of a group's tabs opens a new plain
 * shell in that group; a drag (pointerdown/up further apart
 * than this, e.g. dragging the void to reposition the group) must not.
 */
const VOID_CLICK_DRAG_THRESHOLD_PX = 4;

/**
 * One task's terminal workspace: a dedicated dockview instance, started with
 * a single terminal panel. `WorkspaceView` mounts exactly one of these per
 * task (lazily, on first focus) and keeps it alive — hidden, not unmounted —
 * so ptys and dockview layout survive switching between tasks/views.
 */
export const TaskWorkspace = memo(function TaskWorkspace({
  taskId,
  onCloseTask,
}: {
  taskId: string;
  /**
   * Close a task's workspace: unmounts every pane, ending their
   * ptys. Takes the task id (not a pre-bound closure) so callers can pass one
   * stable callback and `memo` keeps hidden workspaces from re-rendering.
   */
  onCloseTask?: (taskId: string) => void;
}): JSX.Element {
  // Dockview's own api is state (not a ref): the initial-panel effect below
  // needs to re-run once it becomes available, same as it re-runs once the
  // workspace binding resolves — whichever of the two happens last.
  const [api, setApi] = useState<DockviewApi | null>(null);
  const initialPanelCreatedRef = useRef(false);
  // Set once the initial layout (restored or default) is in place: queued
  // URL opens are applied only after it, never clobbered by `fromJSON`.
  const [bootstrapped, setBootstrapped] = useState(false);
  // The worktree the current Pi panel was opened in; a reopened Done task
  // gets a new worktree, and with it a new Pi panel.
  const piPanelCwdRef = useRef<string | undefined>(undefined);
  // Resolved per task state: the worktree path the task's terminals spawn
  // into (undefined without a live binding, falling back to the app's own
  // cwd — see TerminalPane/ptySessions.ts). `cwdLoaded` (below)
  // distinguishes "still loading" from "loaded, no binding" so the initial
  // panel never spawns early with the wrong cwd.
  const [cwd, setCwd] = useState<string | undefined>(undefined);
  // The task state the binding was read for (`null`: not read yet). A read
  // from before a state change is stale: right after a Done task resumes,
  // the board says Working while `cwd` still holds the Done read (none),
  // and the first pane must wait for the new cycle's worktree.
  const [cwdReadFor, setCwdReadFor] = useState<TaskState | undefined | null>(
    null,
  );
  // Read by the split-button header action and the tab-strip void-click
  // handler, both of which are wired up once (stable function identities —
  // see below) and must always see the latest cwd/taskId/api without
  // forcing dockview to recreate its header-actions/group DOM wiring.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const apiRef = useRef<DockviewApi | null>(null);
  // Live task record for the header's Start/Await…/Done/Reopen actions; the same
  // live board every other view reads (see core-client.ts), so the actions'
  // enabled state always reflects the latest state/branch/repositoryId.
  const columns = useBoard();
  const manualRefresh = useManualRefresh();
  // Memoized on the board snapshot: the shared board store keeps the same
  // `columns` reference until the board actually changes.
  const task = useMemo(
    () => flattenBoard(columns).find((row) => row.task.id === taskId)?.task,
    [columns, taskId],
  );

  // Re-resolved whenever the task changes column: a parked backlog task
  // has no binding yet, and `startTask` creates one as it moves to Working.
  const taskState = task?.state;
  useEffect(() => {
    let cancelled = false;
    void window.harbormaster.core.getTaskWorkspace(taskId).then((binding) => {
      if (cancelled) return;
      setCwd(binding?.worktreePath);
      setCwdReadFor(taskState);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, taskState]);
  const cwdLoaded = cwdReadFor !== null;
  // Also waits for the task to be on the board: a workspace restored at
  // launch can read its binding before the board store fills, and a Done
  // task read as "no state" would get a plain shell instead of its card.
  const cwdFresh =
    cwdLoaded && taskState !== undefined && cwdReadFor === taskState;
  // A Done task with nothing to run in (its worktree cleaned up) gets the
  // Resume card instead of a first pane, and keeps it until the resumed
  // cycle's worktree arrives. Decided before the first pane only: panes a
  // task already has stay when it goes Done.
  const awaitingResume =
    !bootstrapped && cwdLoaded && !cwd && (taskState === "done" || !cwdFresh);

  useEffect(() => {
    if (!api || !cwdFresh) return;
    if (!initialPanelCreatedRef.current) {
      // Nothing to run yet: the Resume card shows instead (see above).
      if (!cwd && taskState === "done") return;
      initialPanelCreatedRef.current = true;
      piPanelCwdRef.current = cwd;
      // Restore (task A): a saved layout replaces the single default panel
      // with every panel + split/tab arrangement this task had open last
      // run. Dockview's own `fromJSON` round-trips the "terminal" component
      // and its `{cwd, taskId, primary}` params cleanly on the installed
      // version (verified against `SerializedDockview`/`GroupviewPanelState`
      // typings — no custom layout schema needed). The primary pi pane's
      // `cwd` is patched to the task's *current* worktree first so it
      // resumes through the normal claimSessionLaunch path even if the
      // worktree changed since the layout was saved (e.g. a Done-task
      // reopen); extra shell panels respawn in their saved cwds untouched.
      setBootstrapped(true);
      const saved = readWorkspaceLayout(window.localStorage, taskId);
      if (saved) {
        try {
          api.fromJSON(withLivePrimaryCwd(saved, taskId, cwd));
          return;
        } catch {
          // Corrupt/incompatible saved layout: fall through to the default
          // single-panel bootstrap below instead of leaving an empty dockview.
        }
      }
      api.addPanel({
        id: `${taskId}-terminal-${nextPanelId++}`,
        component: "terminal",
        tabComponent: "terminal",
        // Initial title only — TerminalPane overwrites this on mount via
        // dockview's panel api as soon as it knows pi's launch outcome, and
        // tracks live OSC title changes after that (see lib/terminal-title).
        title: defaultTerminalTitle({ cwd, primary: true }),
        params: { cwd, taskId, primary: true },
      });
      return;
    }
    // Opened while still parked (plain shell), then started — or already
    // showing panes when it went Done, then reopened into a new cycle's
    // worktree: give the task the pi pane it would have had (core
    // resumes/forks its conversation).
    if (cwd && cwd !== piPanelCwdRef.current) {
      piPanelCwdRef.current = cwd;
      api.addPanel({
        id: `${taskId}-terminal-${nextPanelId++}`,
        component: "terminal",
        tabComponent: "terminal",
        title: defaultTerminalTitle({ cwd, primary: true }),
        params: { cwd, taskId, primary: true },
      });
    }
  }, [api, cwdFresh, cwd, taskId, taskState]);

  // Live layout persistence (task A item 3): every panel add/remove/move
  // (splits, tab drags, closes) re-saves this task's full dockview layout,
  // not just on a clean shutdown "- the app can be SIGKILLed by launchctl
  // kickstart with no exit hook to flush state from, so the source of truth
  // must stay current at all times. Dropped on workspace close by App.tsx's
  // `closeTask` (see lib/workspace-persistence), so a closed task never
  // resurrects a stale layout on a later reopen. Nothing is saved before the
  // initial layout is in place: the empty dockview behind a Resume card
  // must never overwrite a saved layout the resumed task restores.
  useEffect(() => {
    if (!api) return;
    const disposable = api.onDidLayoutChange(() => {
      if (!initialPanelCreatedRef.current) return;
      storeWorkspaceLayout(window.localStorage, taskId, api.toJSON());
    });
    return () => disposable.dispose();
  }, [api, taskId]);

  // Agent-opened URLs (docs/plannotator.md): apply this task's queued
  // opens. Only the Review button's open takes focus; a Plannotator URL
  // navigates the one review tab, any other loopback URL gets a preview
  // tab, both without changing the active tab.
  const pendingOpens = useTaskUrls().pending[taskId];
  useEffect(() => {
    if (!api || !bootstrapped || !pendingOpens) return;
    taskUrls.take(taskId);
    for (const open of pendingOpens) applyUrlOpen(api, taskId, open);
  }, [api, bootstrapped, pendingOpens, taskId]);

  // Closing the workspace closes a live review session first (App.tsx,
  // lib/review-close.ts), which reads the review tab's URL from here.
  useEffect(() => {
    if (!api) return;
    return registerReviewSource(
      taskId,
      () =>
        (
          api.getPanel(reviewPanelId(taskId))?.params as
            | UrlPanelParams
            | undefined
        )?.url,
    );
  }, [api, taskId]);

  // What this workspace shows, for Export diagnostics' "what was focused".
  useEffect(() => {
    if (!api) return;
    return registerWorkspaceFocus(taskId, () => {
      const active = api.activePanel;
      return {
        panels: api.panels.length,
        ...(active
          ? {
              activePanel: {
                id: active.id,
                ...(active.title ? { title: active.title.slice(0, 80) } : {}),
                ...(active.view.contentComponent
                  ? { component: active.view.contentComponent }
                  : {}),
              },
            }
          : {}),
      };
    });
  }, [api, taskId]);

  function onReady(event: DockviewReadyEvent): void {
    apiRef.current = event.api;
    setApi(event.api);
  }

  // Stable identity across renders (see cwdRef/apiRef above): dockview's
  // react layer recreates every group's header-actions component instance
  // whenever this function component's identity changes, so it must never
  // be redefined per-render.
  const splitGroupRef = useRef<
    (groupId: string, direction: "right" | "below") => void
  >(() => {});
  splitGroupRef.current = (groupId, direction) => {
    const current = apiRef.current;
    if (!current) return;
    const group = current.getGroup(groupId);
    if (!group) return;
    current.addPanel({
      id: `${taskId}-terminal-${nextPanelId++}`,
      component: "terminal",
      tabComponent: "terminal",
      title: defaultTerminalTitle({ cwd: cwdRef.current, primary: false }),
      params: { cwd: cwdRef.current, taskId, primary: false },
      position: { referenceGroup: group.id, direction },
    });
  };
  const headerActionsComponentRef = useRef(
    makeGroupHeaderActions((groupId, direction) =>
      splitGroupRef.current(groupId, direction),
    ),
  );

  // Click-empty-tab-strip-space = new shell: attach a
  // click-not-drag listener to each group's `.void-container` (dockview's
  // own DOM element for the unoccupied tab-strip area right of the tabs —
  // see dockview-core's TabsContainer/VoidContainer), not a global
  // listener, so dragging that void to reposition a group is unaffected and
  // clicks on actual tabs never reach it.
  useEffect(() => {
    if (!api) return;
    const detachers = new Map<string, () => void>();

    function attach(group: DockviewGroupPanel): void {
      if (detachers.has(group.id)) return;
      const voidEl =
        group.element.querySelector<HTMLElement>(".void-container");
      if (!voidEl) return;
      voidEl.setAttribute("data-testid", "tab-strip-void");
      let pointerDownAt: { x: number; y: number } | null = null;
      const onPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0) return;
        pointerDownAt = { x: event.clientX, y: event.clientY };
      };
      const onPointerUp = (event: PointerEvent): void => {
        const start = pointerDownAt;
        pointerDownAt = null;
        if (!start) return;
        const dx = Math.abs(event.clientX - start.x);
        const dy = Math.abs(event.clientY - start.y);
        if (
          dx > VOID_CLICK_DRAG_THRESHOLD_PX ||
          dy > VOID_CLICK_DRAG_THRESHOLD_PX
        ) {
          return;
        }
        const current = apiRef.current;
        if (!current) return;
        current.addPanel({
          id: `${taskId}-terminal-${nextPanelId++}`,
          component: "terminal",
          tabComponent: "terminal",
          title: defaultTerminalTitle({ cwd: cwdRef.current, primary: false }),
          params: { cwd: cwdRef.current, taskId, primary: false },
          position: { referenceGroup: group.id, direction: "within" },
        });
      };
      voidEl.addEventListener("pointerdown", onPointerDown);
      voidEl.addEventListener("pointerup", onPointerUp);
      detachers.set(group.id, () => {
        voidEl.removeEventListener("pointerdown", onPointerDown);
        voidEl.removeEventListener("pointerup", onPointerUp);
      });
    }

    for (const group of api.groups) attach(group);
    const addGroupDisposable = api.onDidAddGroup((group) => attach(group));
    const removeGroupDisposable = api.onDidRemoveGroup((group) => {
      detachers.get(group.id)?.();
      detachers.delete(group.id);
    });

    return () => {
      addGroupDisposable.dispose();
      removeGroupDisposable.dispose();
      for (const detach of detachers.values()) detach();
      detachers.clear();
    };
  }, [api, taskId]);

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3"
        data-testid="workspace-header"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <SidebarRevealButton />
          {task && <TaskUsageChip task={task} />}
          {task && <TaskAudit taskId={task.id} revision={task.updatedAt} />}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <OpenInButton path={cwd} />
          {task && <TaskActions task={task} />}
          <Button
            size="sm"
            variant="ghost"
            className="w-7 p-0"
            onClick={manualRefresh.refresh}
            disabled={manualRefresh.busy}
            aria-busy={manualRefresh.busy}
            aria-label="Refresh"
            title="Refresh PR status and run movers now"
            data-testid="workspace-refresh-button"
          >
            <RefreshCw
              className={cn(
                "h-3.5 w-3.5",
                manualRefresh.busy && "animate-spin",
              )}
            />
          </Button>
          {onCloseTask && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onCloseTask(taskId)}
              data-testid="close-workspace-button"
              aria-label="Close workspace"
              title="Close this task's workspace and end its terminals (⌘W)"
            >
              <X className="h-3.5 w-3.5" />
              <Kbd>{`${modKeyLabel()}W`}</Kbd>
            </Button>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1" data-testid="dockview-host">
        <DockviewReact
          className="dockview-theme-harbormaster h-full w-full"
          onReady={onReady}
          components={components}
          tabComponents={tabComponents}
          rightHeaderActionsComponent={headerActionsComponentRef.current}
        />
        {/* Over the (still empty) dockview, which stays mounted so its api
            is ready for the first pane the moment the task resumes. */}
        {awaitingResume && task && (
          <div className="absolute inset-0 z-10">
            <ResumeTaskCard task={task} />
          </div>
        )}
      </div>
    </div>
  );
});

/** One queued open (lib/task-urls.ts) applied to a task's dockview. */
function applyUrlOpen(
  api: DockviewApi,
  taskId: string,
  open: TaskUrlOpen,
): void {
  if (open.kind === "review") {
    const id = reviewPanelId(taskId);
    // `url: undefined` clears the old session's URL (dockview merges
    // parameters, deleting undefined keys): the tab shows "starting".
    const params: UrlPanelParams = { taskId, kind: "review", url: open.url };
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.updateParameters(params);
      if (open.focus) existing.api.setActive();
      return;
    }
    api.addPanel({
      id,
      component: "url",
      tabComponent: "url",
      title: "Review",
      params,
      // Hidden tabs keep their frame (and the user's annotations) alive.
      renderer: "always",
      ...(open.focus ? {} : { inactive: true }),
    });
    return;
  }
  const params: UrlPanelParams = { taskId, kind: "preview", url: open.url };
  const existing = api.panels.find(
    (panel) => (panel.params as UrlPanelParams | undefined)?.url === open.url,
  );
  if (existing) return;
  let title = open.url;
  try {
    title = new URL(open.url).host;
  } catch {
    // Keep the raw URL.
  }
  api.addPanel({
    id: `preview:${taskId}:${nextPanelId++}`,
    component: "url",
    tabComponent: "url",
    title,
    params,
    renderer: "always",
    inactive: true,
  });
}
