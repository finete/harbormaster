import { useDroppable } from "@dnd-kit/core";
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import type { JSX } from "react";
import { Fragment, useEffect } from "react";
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
import type { LineageIndex } from "../lib/task-lineage";
import { layoutLineageRows } from "../lib/task-lineage";
import { deriveProvenanceLabel } from "../lib/task-status-lines";
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
  collapsed = false,
  onToggleCollapse,
  onAutoExpandPeek,
  lineageIndex,
  collapsedLineageParents,
  onToggleLineageChildren,
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
  /** Whole-column collapse (the slim rail; see Board.tsx's `collapsedColumns`). Independent of group collapse. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Fired after ~500ms of a drag hovering this column while it's collapsed (Azure DevOps-style auto-expand peek); Board.tsx re-collapses it on drag end/cancel. */
  onAutoExpandPeek?: () => void;
  /** Full-board parent/child + provenance index (see lib/task-lineage.ts), built once per render in Board.tsx. */
  lineageIndex: LineageIndex;
  /** Saved "N children" chip collapse state (lib/sidebar-persistence.ts's `LINEAGE_COLLAPSED_PARENTS_KEY`), shared with the sidebar. */
  collapsedLineageParents: ReadonlySet<string>;
  onToggleLineageChildren: (parentTaskId: string) => void;
}): JSX.Element {
  // The droppable's *node* is the content wrapper inside the cards scroller
  // (so dnd-kit's auto-scroller, which walks the hovered droppable's
  // scrollable ancestors, sees this column's vertical scroller as well as
  // the board's horizontal one), while Board.tsx's droppable `measure`
  // resolves the whole `data-board-column` element — so the drop target is
  // still the entire column, header included.
  const { setNodeRef, isOver } = useDroppable({ id: column.state });

  // Azure DevOps-style auto-expand peek: a sustained ~500ms hover over a
  // collapsed column's rail while a card is being dragged expands it so the
  // drop target is visible; Board.tsx clears the peek (re-collapsing) on
  // drag end/cancel, never this component on its own.
  useEffect(() => {
    if (!collapsed || !isOver || !dragTask || !onAutoExpandPeek) return;
    const timer = setTimeout(onAutoExpandPeek, 500);
    return () => clearTimeout(timer);
  }, [collapsed, isOver, dragTask, onAutoExpandPeek]);

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

  // Collapsed form (the slim rail): same droppable id as the expanded
  // column (`useDroppable({ id: column.state })` above never changes), so
  // drops still land here — only the rendered content differs. The cards
  // scroller (and every testid inside it) simply doesn't mount while
  // collapsed, per the spec's "unmount, don't just hide" rule.
  if (collapsed) {
    return (
      <button
        ref={setNodeRef}
        type="button"
        data-board-column={column.state}
        data-testid={`column-${column.state}`}
        title={`${column.title} \u00b7 ${count.title}`}
        aria-label={`Expand ${column.title}`}
        onClick={onToggleCollapse}
        className={cn(
          "flex w-11 shrink-0 flex-none flex-col items-center gap-2 rounded-lg border border-border bg-muted/30 py-2 text-muted-foreground transition-[flex-basis,width] duration-200 ease-in-out hover:bg-accent hover:text-foreground",
          isOver && "bg-primary/10 ring-1 ring-primary",
        )}
      >
        <span data-testid={`column-rail-${column.state}`} className="contents">
          <ChevronsRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span
            className="min-h-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide [writing-mode:vertical-rl]"
            style={{ transform: "rotate(180deg)" }}
          >
            {column.title}
          </span>
          <span
            className="text-[11px] tabular-nums text-muted-foreground"
            data-testid={`column-${column.state}-count`}
          >
            {count.text}
          </span>
        </span>
      </button>
    );
  }

  return (
    <div
      data-board-column={column.state}
      data-testid={`column-${column.state}`}
      className={cn(
        "flex min-w-[240px] max-w-[720px] flex-1 flex-col gap-2 rounded-lg border border-border bg-muted/30 p-2 transition-[flex-basis,width] duration-200 ease-in-out",
        isOver && "ring-1 ring-primary",
      )}
    >
      <div className="flex items-center justify-between px-1 pb-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
          <Button
            size="sm"
            variant="ghost"
            className="h-5 w-5 p-0 text-muted-foreground"
            data-testid={`column-collapse-${column.state}`}
            aria-label={`Collapse ${column.title}`}
            onClick={onToggleCollapse}
          >
            <ChevronsLeft className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-0.5"
        data-testid={`column-${column.state}-cards`}
      >
        <div ref={setNodeRef} className="flex min-h-full flex-col gap-3">
          {visibleGroups.map((group) => {
            const groupCollapsed = isBoardGroupCollapsed(
              collapsedGroups,
              column.state,
              group.id,
            );
            return (
              <div
                key={group.id}
                className="flex flex-col gap-2"
                data-testid={`group-${column.state}-${group.id}`}
                data-collapsed={groupCollapsed ? "true" : "false"}
              >
                {/* Sticky (item 10): pins to the top of the column scroller
                  while its group's cards scroll underneath. Opaque fill =
                  the column's muted/30 tint composited over the background. */}
                <button
                  type="button"
                  data-testid={`group-toggle-${column.state}-${group.id}`}
                  aria-expanded={!groupCollapsed}
                  onClick={() => onToggleGroup?.(group.id)}
                  className="sticky top-0 z-10 flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-muted-foreground transition-colors [background:linear-gradient(hsl(var(--muted)/0.3),hsl(var(--muted)/0.3)),hsl(var(--background))] hover:text-foreground"
                >
                  {groupCollapsed ? (
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
                {!groupCollapsed && (
                  <div className="flex flex-col gap-2">
                    {layoutLineageRows(
                      group.tasks.map((task) => ({ task })),
                      lineageIndex,
                      collapsedLineageParents,
                    ).map(({ item, nested, children, parentTitle }) => {
                      const task = item.task;
                      const provenanceTitle = deriveProvenanceLabel(
                        task,
                        (id) => lineageIndex.taskById.get(id)?.title,
                      );
                      return (
                        <Fragment key={task.id}>
                          <TaskCard
                            task={task}
                            presence={presence[task.id]}
                            onSelect={onSelectTask}
                            selected={selectedTaskId === task.id}
                            unread={unreadTaskIds?.has(task.id)}
                            nested={nested}
                            {...(parentTitle ? { parentTitle } : {})}
                            {...(provenanceTitle ? { provenanceTitle } : {})}
                          />
                          {children && (
                            <button
                              type="button"
                              data-testid={`lineage-children-toggle-${task.id}`}
                              disabled={!children.nestedHere}
                              aria-expanded={
                                children.nestedHere
                                  ? !children.collapsed
                                  : undefined
                              }
                              onClick={() => onToggleLineageChildren(task.id)}
                              className={cn(
                                "-mt-1 flex items-center gap-1 self-start pl-1 text-[11px] text-muted-foreground",
                                children.nestedHere
                                  ? "hover:text-foreground"
                                  : "cursor-default opacity-70",
                              )}
                            >
                              {children.nestedHere &&
                                (children.collapsed ? (
                                  <ChevronRight
                                    className="h-3 w-3 shrink-0"
                                    aria-hidden
                                  />
                                ) : (
                                  <ChevronDown
                                    className="h-3 w-3 shrink-0"
                                    aria-hidden
                                  />
                                ))}
                              {children.count}{" "}
                              {children.count === 1 ? "child" : "children"}
                            </button>
                          )}
                        </Fragment>
                      );
                    })}
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
