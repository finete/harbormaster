import { useDroppable } from "@dnd-kit/core";
import type { JSX } from "react";
import type {
  BoardColumn as BoardColumnData,
  PresenceChangedPayload,
} from "../../../preload/api";
import { visibleGroupsForColumn } from "../lib/board-selection";
import { repoColorClass } from "../lib/repo-color";
import { cn } from "../lib/utils";
import { TaskCard } from "./TaskCard";
import { Button } from "./ui/button";

export function BoardColumn({
  column,
  presence,
  onSelectTask,
  showArchived,
  onToggleArchived,
  selectedTaskId,
  unreadTaskIds,
}: {
  column: BoardColumnData;
  presence: PresenceChangedPayload;
  onSelectTask: (taskId: string) => void;
  /** Done-column-only: whether archived tasks (`task.archivedAt` set) are currently shown. Unused for every other column. */
  showArchived?: boolean;
  onToggleArchived?: () => void;
  /** Keyboard-selected card id (see Board.tsx/lib/board-selection.ts), or absent outside the board view. */
  selectedTaskId?: string | null;
  /** "Finished while you weren't looking" task ids (see core-client.ts's useUnreadTaskIds). */
  unreadTaskIds?: ReadonlySet<string>;
}): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: column.state });

  const archivedCount = column.groups.reduce(
    (total, group) =>
      total + group.tasks.filter((task) => task.archivedAt).length,
    0,
  );
  // Archived tasks are hidden by default, done-column only (see
  // /AGENTS.md-adjacent design note in core-manager.ts's archiveDoneTasks):
  // every other column never has an archivedAt task to begin with. Shared
  // with Board.tsx's keyboard-selection grid so both always agree on what's
  // actually on screen.
  const visibleGroups = visibleGroupsForColumn(column, Boolean(showArchived));
  const taskCount = visibleGroups.reduce(
    (total, group) => total + group.tasks.length,
    0,
  );

  return (
    <div
      ref={setNodeRef}
      data-testid={`column-${column.state}`}
      className={cn(
        "flex min-w-[240px] flex-1 flex-col gap-2 rounded-lg border border-border bg-muted/30 p-2",
        isOver && "ring-1 ring-primary",
      )}
    >
      <div className="flex items-center justify-between px-1 pb-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {column.title}
        </h2>
        <div className="flex items-center gap-2">
          {column.state === "done" && archivedCount > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[11px] text-muted-foreground"
              data-testid="toggle-archived-button"
              onClick={onToggleArchived}
            >
              {showArchived ? "hide" : "show"} archived ({archivedCount})
            </Button>
          )}
          <span className="text-xs text-muted-foreground">{taskCount}</span>
        </div>
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5"
        data-testid={`column-${column.state}-cards`}
      >
        {visibleGroups.map((group) => (
          <div
            key={group.id}
            className="flex flex-col gap-2"
            data-testid={`group-${column.state}-${group.id}`}
          >
            {(group.primaryLabel || group.repoLabel) && (
              <div className="flex items-baseline gap-1.5 px-1">
                {group.primaryLabel && (
                  <span
                    className="text-xs font-semibold text-primary"
                    data-testid="group-primary-label"
                  >
                    {group.primaryLabel}
                  </span>
                )}
                {group.repoLabel && (
                  <span
                    className={cn(
                      "text-xs font-semibold",
                      repoColorClass(group.repoLabel),
                    )}
                    data-testid="group-repo-label"
                  >
                    {group.repoLabel}
                  </span>
                )}
              </div>
            )}
            <div className="flex flex-col gap-2">
              {group.tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  presence={presence[task.id]}
                  onSelect={onSelectTask}
                  selected={selectedTaskId === task.id}
                  unread={unreadTaskIds?.has(task.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
