import { useDroppable } from "@dnd-kit/core";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { JSX } from "react";
import type {
  BoardColumn as BoardColumnData,
  PresenceChangedPayload,
  Task,
} from "../../../preload/api";
import {
  columnCountLabel,
  isBoardGroupCollapsed,
  visibleGroupsForColumn,
} from "../lib/board-selection";
import { repoColorClass } from "../lib/repo-color";
import { cn } from "../lib/utils";
import { TaskCard } from "./TaskCard";
import { Button } from "./ui/button";

/** Copy for the drop-placement preview (item 7): what releasing here will do. */
function dropPreviewLabel(state: BoardColumnData["state"]): string {
  switch (state) {
    case "awaiting":
      return "Drop to choose what it's waiting on";
    case "done":
      return "Drop to mark done (cleans up the worktree)";
    case "dev":
      return "Drop to start / move to Dev";
    default:
      return `Drop to move to ${state}`;
  }
}

function DropPreview({ state }: { state: BoardColumnData["state"] }) {
  return (
    <div
      data-testid={`drop-placeholder-${state}`}
      className="flex h-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-primary/70 bg-primary/5 px-2 text-center text-[11px] text-primary"
    >
      {dropPreviewLabel(state)}
    </div>
  );
}

export function BoardColumn({
  column,
  presence,
  onSelectTask,
  showArchived,
  onToggleArchived,
  selectedTaskId,
  unreadTaskIds,
  collapsedGroups,
  onToggleGroup,
  dragTask,
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
  /** Saved `boardGroupKey(column, group)` set (see Board.tsx); a collapsed group shows only its header. */
  collapsedGroups?: ReadonlySet<string>;
  onToggleGroup?: (groupId: string) => void;
  /** The task currently being dragged (Board.tsx), for the drop-placement preview. */
  dragTask?: Task | undefined;
}): JSX.Element {
  // The droppable's *node* is the content wrapper inside the cards scroller
  // (so dnd-kit's auto-scroller, which walks the hovered droppable's
  // scrollable ancestors, sees this column's vertical scroller as well as
  // the board's horizontal one), while Board.tsx's droppable `measure`
  // resolves the whole `data-board-column` element — so the drop target is
  // still the entire column, header included.
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
  // Honest counts (item 14): while archived cards are hidden the header
  // reads "shown/total", never just the filtered number.
  const hiddenArchived =
    column.state === "done" && !showArchived ? archivedCount : 0;
  const count = columnCountLabel(taskCount, hiddenArchived);

  // Drop-placement preview (item 7): ordering inside a group is automatic
  // (core's board-grouping sorts by stateChangedAt, so a moved card lands
  // last in its repository's group), so the preview sits exactly there —
  // or at the column's end when that group doesn't exist yet / is collapsed
  // / the column is Awaiting (its group depends on the reason picked next).
  const showDropPreview =
    isOver && !!dragTask && dragTask.state !== column.state;
  const landingGroupId =
    showDropPreview && column.state !== "awaiting"
      ? (dragTask?.repositoryId ?? "scratch")
      : null;
  const previewInGroup =
    landingGroupId !== null &&
    visibleGroups.some(
      (group) =>
        group.id === landingGroupId &&
        !isBoardGroupCollapsed(collapsedGroups, column.state, group.id),
    );

  return (
    <div
      data-board-column={column.state}
      data-testid={`column-${column.state}`}
      className={cn(
        "flex min-w-[240px] max-w-[480px] flex-1 flex-col gap-2 rounded-lg border border-border bg-muted/30 p-2",
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
          <span
            className="text-xs tabular-nums text-muted-foreground"
            data-testid={`column-${column.state}-count`}
            title={count.title}
          >
            {count.text}
          </span>
        </div>
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-0.5"
        data-testid={`column-${column.state}-cards`}
      >
        <div ref={setNodeRef} className="flex min-h-full flex-col gap-3">
          {visibleGroups.map((group) => {
            const collapsed = isBoardGroupCollapsed(
              collapsedGroups,
              column.state,
              group.id,
            );
            return (
              <div
                key={group.id}
                className="flex flex-col gap-2"
                data-testid={`group-${column.state}-${group.id}`}
                data-collapsed={collapsed ? "true" : "false"}
              >
                {/* Sticky (item 10): pins to the top of the column scroller
                  while its group's cards scroll underneath. Opaque fill =
                  the column's muted/30 tint composited over the background. */}
                <button
                  type="button"
                  data-testid={`group-toggle-${column.state}-${group.id}`}
                  aria-expanded={!collapsed}
                  onClick={() => onToggleGroup?.(group.id)}
                  className="sticky top-0 z-10 flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-muted-foreground transition-colors [background:linear-gradient(hsl(var(--muted)/0.3),hsl(var(--muted)/0.3)),hsl(var(--background))] hover:text-foreground"
                >
                  {collapsed ? (
                    <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
                  ) : (
                    <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
                  )}
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    {group.primaryLabel && (
                      <span
                        className="truncate text-xs font-semibold text-primary"
                        data-testid="group-primary-label"
                      >
                        {group.primaryLabel}
                      </span>
                    )}
                    {group.repoLabel && (
                      <span
                        className={cn(
                          "truncate text-xs font-semibold",
                          repoColorClass(group.repoLabel),
                        )}
                        data-testid="group-repo-label"
                      >
                        {group.repoLabel}
                      </span>
                    )}
                  </span>
                  <span
                    className="ml-auto text-[11px] tabular-nums text-muted-foreground/70"
                    data-testid="group-count"
                  >
                    {group.tasks.length}
                  </span>
                </button>
                {!collapsed && (
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
                    {previewInGroup && group.id === landingGroupId && (
                      <DropPreview state={column.state} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {showDropPreview && !previewInGroup && (
            <DropPreview state={column.state} />
          )}
          {/* Empty column (item 11): the whole column is the drop target;
            this hint makes that visible instead of a blank strip. */}
          {visibleGroups.length === 0 && !showDropPreview && (
            <div
              data-testid={`column-${column.state}-empty`}
              className="flex min-h-24 flex-1 items-center justify-center rounded-lg border border-dashed border-border px-2 text-center text-[11px] text-muted-foreground"
            >
              {hiddenArchived > 0
                ? "Only archived tasks · drop a card here"
                : "No tasks · drop a card here"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
