import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
} from "dockview-react";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import "dockview-react/dist/styles/dockview.css";
import { Plus } from "lucide-react";
import { TerminalPane } from "./TerminalPane";
import { Button } from "./ui/button";

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
export function TaskWorkspace({ taskId }: { taskId: string }): JSX.Element {
  // Dockview's own api is state (not a ref): the initial-panel effect below
  // needs to re-run once it becomes available, same as it re-runs once the
  // workspace binding resolves — whichever of the two happens last.
  const [api, setApi] = useState<DockviewApi | null>(null);
  const initialPanelCreatedRef = useRef(false);
  // Resolved once per task: the worktree path a repository-backed task's
  // terminals should spawn into (undefined for scratch tasks, falling back
  // to the app's own cwd — see TerminalPane/ptySessions.ts). `cwdLoaded`
  // distinguishes "still loading" from "loaded, no binding" so the initial
  // panel never spawns early with the wrong cwd.
  const [cwd, setCwd] = useState<string | undefined>(undefined);
  const [cwdLoaded, setCwdLoaded] = useState(false);

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
  }, [taskId]);

  useEffect(() => {
    if (!api || !cwdLoaded || initialPanelCreatedRef.current) return;
    initialPanelCreatedRef.current = true;
    api.addPanel({
      id: `${taskId}-terminal-${nextPanelId++}`,
      component: "terminal",
      title: "Shell",
      params: { cwd },
    });
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
      params: { cwd },
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
        <Button
          size="sm"
          variant="outline"
          onClick={addTerminal}
          data-testid="add-terminal-button"
        >
          <Plus className="h-3.5 w-3.5" />
          terminal
        </Button>
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
