import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
} from "dockview-react";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import "dockview-react/dist/styles/dockview.css";
import { Plus, RefreshCw, X } from "lucide-react";
import { flattenBoard, useBoard, useManualRefresh } from "../core-client";
import { modKeyLabel } from "../lib/platform";
import { cn } from "../lib/utils";
import { TaskActions } from "./TaskActions";
import { TerminalPane } from "./TerminalPane";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

const components = {
  terminal: TerminalPane,
};

let nextPanelId = 1;

/**
 * One task's terminal workspace: a dedicated dockview instance, started with
 * a single terminal panel. `WorkspaceView` mounts exactly one of these per
 * task (lazily, on first focus) and keeps it alive — hidden, not unmounted —
 * so ptys and dockview layout survive switching between tasks/views.
 */
export function TaskWorkspace({
  taskId,
  onClose,
}: {
  taskId: string;
  /** Close this task's workspace (cmux-style): unmounts every pane, ending their ptys. */
  onClose?: () => void;
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
  // Live task record for the header's "To review"/"Done" actions; the same
  // live board every other view reads (see core-client.ts), so the actions'
  // enabled state always reflects the latest state/branch/repositoryId.
  const columns = useBoard();
  const manualRefresh = useManualRefresh();
  const task = flattenBoard(columns).find(
    (row) => row.task.id === taskId,
  )?.task;

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
      api.addPanel({
        id: `${taskId}-terminal-${nextPanelId++}`,
        component: "terminal",
        // The first panel in a bound task's workspace runs pi (see
        // TerminalPane.tsx / main/index.ts's pty:create handler); scratch
        // tasks (no `cwd`, no binding) keep the plain-shell title/behavior.
        title: cwd ? "Pi" : "Shell",
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
        title: "Pi",
        params: { cwd, taskId, primary: true },
      });
    }
  }, [api, cwdLoaded, cwd, taskId]);

  function onReady(event: DockviewReadyEvent): void {
    setApi(event.api);
  }

  function addTerminal(): void {
    if (!api) return;
    const activePanel = api.activePanel;
    api.addPanel({
      id: `${taskId}-terminal-${nextPanelId++}`,
      component: "terminal",
      title: "Shell",
      params: { cwd, taskId, primary: false },
      ...(activePanel
        ? {
            position: {
              referencePanel: activePanel.id,
              direction: "right" as const,
            },
          }
        : {}),
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-muted/20 px-2 py-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Terminals
        </span>
        <div className="flex items-center gap-2">
          {task && <TaskActions task={task} />}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
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
          <Button
            size="sm"
            variant="outline"
            onClick={addTerminal}
            data-testid="add-terminal-button"
          >
            <Plus className="h-3.5 w-3.5" />
            terminal
          </Button>
          {onClose && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onClose}
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
          className="dockview-theme-dark h-full w-full"
          onReady={onReady}
          components={components}
        />
      </div>
    </div>
  );
}
