import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  LayoutGrid,
  Plus,
  Search,
  X,
} from "lucide-react";
import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useBoard, usePresenceMap } from "../core-client";
import { cn } from "../lib/utils";
import { NewTaskDialog } from "./NewTaskDialog";
import { SidebarTaskRow, StatusDot } from "./SidebarTaskRow";
import {
  clampSidebarWidth,
  groupRows,
  matchesQuery,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarRows,
} from "./sidebar-model";
import { Button } from "./ui/button";

const WIDTH_KEY = "harbormaster.sidebar.width";
const COLLAPSED_KEY = "harbormaster.sidebar.collapsed";
/** Relative times ("now", "3m", ...) re-render at least this often. */
const CLOCK_TICK_MS = 30_000;

function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    return raw === null
      ? SIDEBAR_DEFAULT_WIDTH
      : clampSidebarWidth(Number(raw));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable/full: layout just won't persist this session.
  }
}

/** Wall-clock `Date.now()` that re-renders its caller every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Workspace-view task rail, modeled on Orca's worktree sidebar: rows
 * grouped by repository (collapsible, "scratch" last, running tasks first),
 * a type-to-filter search box, drag-to-resize right edge (persisted), and a
 * collapse toggle down to a thin strip of status dots. Clicking a row
 * focuses that task through App's takeover-guarded `selectTask`. The footer
 * keeps "+ New task" and the "Board" button (Cmd+B also works, see App.tsx).
 * Archived tasks are always excluded (the Done column's "show archived"
 * toggle is board-only; see BoardColumn.tsx).
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
  const presence = usePresenceMap();
  const now = useNow(CLOCK_TICK_MS);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsed, setCollapsed] = useState(readStoredCollapsed);
  const [width, setWidth] = useState(readStoredWidth);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(
    () => sidebarRows(columns, presence),
    [columns, presence],
  );
  const groups = useMemo(() => groupRows(rows), [rows]);
  const searching = query.trim().length > 0;
  const visibleGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          rows: group.rows.filter((row) => matchesQuery(row, query)),
        }))
        .filter((group) => group.rows.length > 0),
    [groups, query],
  );

  const toggleCollapsed = (): void => {
    setCollapsed((current) => {
      store(COLLAPSED_KEY, String(!current));
      return !current;
    });
  };

  const toggleGroup = (label: string): void => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const commitWidth = (next: number): void => {
    const clamped = clampSidebarWidth(next);
    setWidth(clamped);
    store(WIDTH_KEY, String(clamped));
  };

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width };
    setResizing(true);
  };
  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    setWidth(clampSidebarWidth(drag.startWidth + event.clientX - drag.startX));
  };
  const onResizeEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    commitWidth(drag.startWidth + event.clientX - drag.startX);
  };
  const onResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 40 : 10;
    if (event.key === "ArrowLeft") commitWidth(width - step);
    else if (event.key === "ArrowRight") commitWidth(width + step);
    else return;
    event.preventDefault();
  };

  const onSearchKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (query) setQuery("");
    else searchRef.current?.blur();
  };

  const newTaskDialog = (
    <NewTaskDialog
      open={newTaskOpen}
      onOpenChange={setNewTaskOpen}
      onCreate={(input) => {
        void window.harbormaster.core
          .createTask({
            title: input.title,
            initialPrompt: input.initialPrompt ?? "",
            ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
            ...(input.start ? { start: true } : {}),
          })
          .catch((error: unknown) => {
            console.error("createTask failed:", error);
          });
      }}
    />
  );

  if (collapsed) {
    return (
      <div
        data-testid="sidebar"
        data-collapsed="true"
        className="flex h-full w-12 shrink-0 flex-col items-center border-r border-border bg-muted/10"
      >
        <button
          type="button"
          data-testid="sidebar-collapse"
          aria-expanded={false}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          onClick={toggleCollapsed}
          className="mt-2 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <ChevronsRight className="h-4 w-4" aria-hidden />
        </button>
        <div className="mt-2 flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-1">
          {groups.flatMap((group) =>
            group.rows.map((row) => (
              <button
                key={row.task.id}
                type="button"
                data-testid={`sidebar-collapsed-row-${row.task.id}`}
                aria-pressed={focusedTaskId === row.task.id}
                aria-label={row.task.title}
                title={`${row.task.title} · ${group.label}`}
                onClick={() => onSelectTask(row.task.id)}
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent/50",
                  focusedTaskId === row.task.id && "bg-accent/70",
                )}
              >
                <StatusDot presence={row.presence} />
              </button>
            )),
          )}
        </div>
        <div className="flex flex-col items-center gap-1 border-t border-border py-2">
          <button
            type="button"
            data-testid="sidebar-new-task-button"
            aria-label="New task"
            title="New task"
            onClick={() => setNewTaskOpen(true)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            data-testid="board-button"
            aria-label="Board"
            title="Board (\u2318B)"
            onClick={onShowBoard}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <LayoutGrid className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {newTaskDialog}
      </div>
    );
  }

  return (
    <div
      data-testid="sidebar"
      data-collapsed="false"
      style={{ width }}
      className={cn(
        "relative flex h-full shrink-0 flex-col border-r border-border bg-muted/10",
        resizing && "select-none",
      )}
    >
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Tasks
        </span>
        <span
          className="text-[11px] tabular-nums text-muted-foreground/70"
          data-testid="sidebar-task-count"
        >
          {rows.length}
        </span>
        <button
          type="button"
          data-testid="sidebar-collapse"
          aria-expanded={true}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          onClick={toggleCollapsed}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <ChevronsLeft className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            ref={searchRef}
            type="text"
            data-testid="sidebar-search"
            aria-label="Filter tasks"
            placeholder="Filter tasks…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            spellCheck={false}
            className="h-8 w-full rounded-md border border-border bg-background/40 pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
          />
          {query && (
            <button
              type="button"
              data-testid="sidebar-search-clear"
              aria-label="Clear filter"
              title="Clear (Esc)"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {rows.length === 0 && (
          <p
            data-testid="sidebar-empty-hint"
            className="px-4 py-4 text-xs text-muted-foreground"
          >
            No tasks yet — create one to get started.
          </p>
        )}
        {rows.length > 0 && visibleGroups.length === 0 && (
          <p
            data-testid="sidebar-search-empty"
            className="px-4 py-4 text-xs text-muted-foreground"
          >
            No tasks match “{query.trim()}”.
          </p>
        )}
        {visibleGroups.map((group) => {
          // A live filter always shows its matches, even inside a group
          // the user collapsed.
          const open = searching || !collapsedGroups.has(group.label);
          return (
            <section
              key={group.label}
              data-testid={`sidebar-group-${group.label}`}
              className="pt-1"
            >
              <button
                type="button"
                data-testid={`sidebar-group-toggle-${group.label}`}
                aria-expanded={open}
                onClick={() => toggleGroup(group.label)}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
              >
                {open ? (
                  <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
                )}
                <span className="truncate normal-case">{group.label}</span>
                <span
                  className="ml-auto font-normal tabular-nums text-muted-foreground/70"
                  data-testid="sidebar-group-count"
                >
                  {group.rows.length}
                </span>
              </button>
              {open && (
                <div className="border-y border-border/40">
                  {group.rows.map((row) => (
                    <SidebarTaskRow
                      key={row.task.id}
                      row={row}
                      selected={focusedTaskId === row.task.id}
                      now={now}
                      onSelect={onSelectTask}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 border-t border-border px-3 py-2">
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => setNewTaskOpen(true)}
          data-testid="sidebar-new-task-button"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          New task
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
      {/* Straddles the right border so the grab target sits on the seam. */}
      {/* biome-ignore lint/a11y/useSemanticElements: an <hr> cannot host pointer/keyboard resize handlers */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        data-testid="sidebar-resize-handle"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onDoubleClick={() => commitWidth(SIDEBAR_DEFAULT_WIDTH)}
        onKeyDown={onResizeKey}
        title="Drag to resize · double-click to reset"
        className="group absolute -right-1.5 top-0 z-10 flex h-full w-3 cursor-col-resize justify-center outline-none"
      >
        <span
          className={cn(
            "h-full w-px bg-transparent transition-colors group-hover:bg-primary/50 group-focus-visible:bg-primary",
            resizing && "bg-primary",
          )}
        />
      </div>
      {newTaskDialog}
    </div>
  );
}
