import { LayoutGrid, Loader2 } from "lucide-react";
import type { JSX } from "react";
import { cn } from "../lib/utils";
import { type ColumnId, columnOf, mockCards, taskOrder } from "../mock";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const statusDotClass: Record<ColumnId, string> = {
  backlog: "bg-zinc-500",
  dev: "bg-blue-500",
  awaiting: "bg-yellow-500",
  done: "bg-green-500",
};

const prVariant = {
  open: "success",
  draft: "draft",
  merged: "merged",
} as const;

/**
 * Narrow task list for the workspace view. Lists every mock task (flat,
 * board column order) with a status dot, title, branch, and PR badge;
 * clicking a row focuses that task's terminal workspace. The "Board"
 * button is the only in-UI way back to the kanban board (Cmd+B also works,
 * see App.tsx).
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
  return (
    <div
      data-testid="sidebar"
      className="flex h-full w-[280px] shrink-0 flex-col border-r border-border bg-muted/10"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Tasks
        </span>
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
      <div className="flex-1 overflow-y-auto">
        {taskOrder.map((taskId) => {
          const task = mockCards[taskId];
          if (!task) return null;
          const column = columnOf(taskId);
          const selected = focusedTaskId === taskId;
          return (
            <button
              key={taskId}
              type="button"
              data-testid={`sidebar-task-row-${taskId}`}
              aria-pressed={selected}
              onClick={() => onSelectTask(taskId)}
              className={cn(
                "flex w-full flex-col gap-1 border-b border-border/50 px-3 py-2 text-left transition-colors hover:bg-muted/40",
                selected && "bg-muted/60",
              )}
            >
              <div className="flex items-center gap-2">
                {task.running ? (
                  <Loader2
                    className="h-2.5 w-2.5 shrink-0 animate-spin text-blue-400"
                    aria-hidden
                    data-testid="sidebar-row-spinner"
                  />
                ) : (
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      statusDotClass[column],
                    )}
                    aria-hidden
                    data-testid="sidebar-row-status-dot"
                  />
                )}
                <span className="truncate text-sm">{task.title}</span>
              </div>
              <div className="flex items-center justify-between gap-2 pl-[18px]">
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {task.branch}
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
    </div>
  );
}
