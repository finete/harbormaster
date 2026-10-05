import { LayoutGrid, Loader2 } from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";
import type { Task, TaskState } from "../../../preload/api";
import { flattenBoard, useBoard } from "../core-client";
import { cn } from "../lib/utils";
import { NewTaskDialog } from "./NewTaskDialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const statusDotClass: Record<TaskState, string> = {
  backlog: "bg-zinc-500",
  dev: "bg-blue-500",
  awaiting: "bg-yellow-500",
  done: "bg-green-500",
};

const prVariant = {
  open: "success",
  draft: "draft",
  merged: "merged",
  closed: "closed",
} as const;

// TODO(presence): always false until the Pi harness presence adapter lands
// (see /docs/design-decisions.md item 13). Kept as a named flag, not
// inlined, so the spinner rendering path + its testid stay alive.
function isRunning(_task: Task): boolean {
  return false;
}

/**
 * Narrow task list for the workspace view: every task on the live board,
 * flattened in column order, with a status dot, title, branch, and PR
 * badge; clicking a row focuses that task's terminal workspace. The
 * "Board" button is the only in-UI way back to the kanban board (Cmd+B also
 * works, see App.tsx). "+ New task" opens the same create dialog as the
 * board header.
 */
export function Sidebar({
  focusedTaskId,
  onSelectTask,
  onShowBoard,
}: {
  focusedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onShowBoard: () => void;
}): JSX.Element {
  const columns = useBoard();
  const rows = flattenBoard(columns);
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  return (
    <div
      data-testid="sidebar"
      className="flex h-full w-[280px] shrink-0 flex-col border-r border-border bg-muted/10"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Tasks
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setNewTaskOpen(true)}
            data-testid="sidebar-new-task-button"
          >
            + New task
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onShowBoard}
            data-testid="board-button"
            title="Board (\u2318B)"
          >
            <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
            Board
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 && (
          <p
            data-testid="sidebar-empty-hint"
            className="px-3 py-4 text-xs text-muted-foreground"
          >
            No tasks yet — create one to get started.
          </p>
        )}
        {rows.map(({ task, state }) => {
          const selected = focusedTaskId === task.id;
          const running = isRunning(task);
          return (
            <button
              key={task.id}
              type="button"
              data-testid={`sidebar-task-row-${task.id}`}
              aria-pressed={selected}
              onClick={() => onSelectTask(task.id)}
              className={cn(
                "flex w-full flex-col gap-1 border-b border-border/50 px-3 py-2 text-left transition-colors hover:bg-muted/40",
                selected && "bg-muted/60",
              )}
            >
              <div className="flex items-center gap-2">
                {running ? (
                  <Loader2
                    className="h-2.5 w-2.5 shrink-0 animate-spin text-blue-400"
                    aria-hidden
                    data-testid="sidebar-row-spinner"
                  />
                ) : (
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      statusDotClass[state],
                    )}
                    aria-hidden
                    data-testid="sidebar-row-status-dot"
                  />
                )}
                <span className="truncate text-sm">{task.title}</span>
              </div>
              <div className="flex items-center justify-between gap-2 pl-[18px]">
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {task.branch ?? ""}
                </span>
                {task.pr && (
                  <Badge
                    variant={prVariant[task.pr.state]}
                    className="shrink-0 text-[10px]"
                    data-testid="badge-pr"
                  >
                    #{task.pr.number}
                  </Badge>
                )}
              </div>
            </button>
          );
        })}
      </div>
      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        onCreate={(input) => {
          void window.harbormaster.core
            .createTask({
              title: input.title,
              initialPrompt: "",
              ...(input.repositoryId
                ? { repositoryId: input.repositoryId }
                : {}),
            })
            .catch((error: unknown) => {
              console.error("createTask failed:", error);
            });
        }}
      />
    </div>
  );
}
