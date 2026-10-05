import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
} from "dockview-react";
import type { JSX } from "react";
import { useRef } from "react";
import "dockview-react/dist/styles/dockview.css";
import { Plus } from "lucide-react";
import { TerminalPane } from "./TerminalPane";
import { Button } from "./ui/button";

const components = {
  terminal: TerminalPane,
};

let nextPanelId = 1;

export function TerminalsHost(): JSX.Element {
  const apiRef = useRef<DockviewApi | null>(null);

  function onReady(event: DockviewReadyEvent): void {
    apiRef.current = event.api;
    event.api.addPanel({
      id: `terminal-${nextPanelId++}`,
      component: "terminal",
      title: "Shell",
    });
  }

  function addTerminal(): void {
    const api = apiRef.current;
    if (!api) return;
    const activePanel = api.activePanel;
    api.addPanel({
      id: `terminal-${nextPanelId++}`,
      component: "terminal",
      title: "Shell",
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
