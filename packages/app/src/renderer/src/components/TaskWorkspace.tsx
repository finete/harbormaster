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
import { flattenBoard, useBoard, useManualRefresh } from "../core-client";
import { modKeyLabel } from "../lib/platform";
import { defaultTerminalTitle } from "../lib/terminal-title";
import { cn } from "../lib/utils";
import {
  readWorkspaceLayout,
  storeWorkspaceLayout,
  withLivePrimaryCwd,
} from "../lib/workspace-persistence";
import { makeGroupHeaderActions } from "./GroupHeaderActions";
import { OpenInButton } from "./OpenInButton";
import { TaskActions } from "./TaskActions";
import { TaskAudit } from "./TaskAudit";
import { TerminalPane } from "./TerminalPane";
import { TerminalTab } from "./TerminalTab";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

const components = {
  terminal: TerminalPane,
};

const tabComponents = {
  terminal: TerminalTab,
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
  // The worktree the current Pi panel was opened in; a reopened Done task
  // gets a new worktree, and with it a new Pi panel.
  const piPanelCwdRef = useRef<string | undefined>(undefined);
  // Resolved once per task: the worktree path a repository-backed task's
  // terminals should spawn into (undefined for scratch tasks, falling back
  // to the app's own cwd — see TerminalPane/ptySessions.ts). `cwdLoaded`
  // distinguishes "still loading" from "loaded, no binding" so the initial
  // panel never spawns early with the wrong cwd.
  const [cwd, setCwd] = useState<string | undefined>(undefined);
  const [cwdLoaded, setCwdLoaded] = useState(false);
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
  // has no binding yet, and `startTask` creates one as it moves to Dev.
  const taskState = task?.state;
  // biome-ignore lint/correctness/useExhaustiveDependencies: taskState is a deliberate re-fetch trigger, see comment above.
  useEffect(() => {
    let cancelled = false;
    void window.harbormaster.core.getTaskWorkspace(taskId).then((binding) => {
      if (cancelled) return;
      setCwd(binding?.worktreePath);
      setCwdLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, taskState]);

  useEffect(() => {
    if (!api || !cwdLoaded) return;
    if (!initialPanelCreatedRef.current) {
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
    // Opened while still parked (plain shell), then started — or opened
    // while Done, then reopened into a new cycle's worktree: give the task
    // the pi pane it would have had (core resumes/forks its conversation).
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
  }, [api, cwdLoaded, cwd, taskId]);

  // Live layout persistence (task A item 3): every panel add/remove/move
  // (splits, tab drags, closes) re-saves this task's full dockview layout,
  // not just on a clean shutdown "- the app can be SIGKILLed by launchctl
  // kickstart with no exit hook to flush state from, so the source of truth
  // must stay current at all times. Dropped on workspace close by App.tsx's
  // `closeTask` (see lib/workspace-persistence), so a closed task never
  // resurrects a stale layout on a later reopen.
  useEffect(() => {
    if (!api) return;
    const disposable = api.onDidLayoutChange(() => {
      storeWorkspaceLayout(window.localStorage, taskId, api.toJSON());
    });
    return () => disposable.dispose();
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
      <div className="min-h-0 flex-1" data-testid="dockview-host">
        <DockviewReact
          className="dockview-theme-harbormaster h-full w-full"
          onReady={onReady}
          components={components}
          tabComponents={tabComponents}
          rightHeaderActionsComponent={headerActionsComponentRef.current}
        />
      </div>
    </div>
  );
});
