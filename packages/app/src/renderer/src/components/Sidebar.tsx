import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  LayoutGrid,
  Pin,
  Plus,
  Search,
  X,
} from "lucide-react";
import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "../../../preload/api";
import {
  flattenBoard,
  useBoard,
  usePresenceMap,
  useUnreadTaskIds,
} from "../core-client";
import { modKeyLabel } from "../lib/platform";
import { repoColorClass } from "../lib/repo-color";
import { cycleTaskId } from "../lib/sidebar-cycle";
import {
  readCollapsedGroups,
  readCollapsedLineageParents,
  readPinnedTaskIds,
  storeCollapsedGroups,
  storeCollapsedLineageParents,
  storePinnedTaskIds,
  togglePinned,
} from "../lib/sidebar-persistence";
import { buildLineageIndex, layoutLineageRows } from "../lib/task-lineage";
import { deriveProvenanceLabel } from "../lib/task-status-lines";
import { CLOCK_TICK_MS, useNow } from "../lib/use-now";
import { cn } from "../lib/utils";
import { NewTaskDialog, type NewTaskDialogResult } from "./NewTaskDialog";
import {
  type ContextMenuItem,
  SidebarRowContextMenu,
} from "./SidebarRowContextMenu";
import { SidebarTaskRow, StatusDot } from "./SidebarTaskRow";
import {
  clampSidebarWidth,
  groupRows,
  matchesQuery,
  partitionPinned,
  pullRequestUrl,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarRows,
  visibleTaskOrder,
} from "./sidebar-model";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

const WIDTH_KEY = "harbormaster.sidebar.width";
const COLLAPSED_KEY = "harbormaster.sidebar.collapsed";

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

/**
 * Workspace-view task rail, modeled on cmux's sidebar: the rail lists only
 * *open* task workspaces (`openedTaskIds`, owned by App.tsx), not the full
 * board inventory -- the Board stays the full inventory. Rows are grouped
 * by repository (collapsible, "scratch" last, running tasks first), a
 * type-to-filter search box, drag-to-resize right edge (persisted), and a
 * collapse toggle down to a thin strip of status dots. Clicking a row
 * focuses that task through App's takeover-guarded `selectTask`; each row's
 * hover close button (or a middle-click) closes just that task's workspace
 * through `onCloseTask` (App's `requestCloseTask`) without touching its
 * board state. The footer keeps "+ New task" and the "Board" button (Cmd+B
 * also works, see App.tsx). Archived tasks are always excluded (the Done
 * column's "show archived" toggle is board-only; see BoardColumn.tsx).
 */
export function Sidebar({
  focusedTaskId,
  openedTaskIds,
  onSelectTask,
  onCloseTask,
  onShowBoard,
  onCreateTask,
  openNewTaskSignal,
}: {
  focusedTaskId: string | null;
  openedTaskIds: ReadonlySet<string>;
  onSelectTask: (taskId: string) => void;
  onCloseTask: (taskId: string) => void;
  onShowBoard: () => void;
  onCreateTask: (input: NewTaskDialogResult) => void;
  /** Bumped by App.tsx's Cmd/Ctrl+N handler while the workspace view is active; opens this sidebar's New Task dialog. */
  openNewTaskSignal?: number;
}): JSX.Element {
  const columns = useBoard();
  const presence = usePresenceMap();
  const now = useNow(CLOCK_TICK_MS);
  const unreadTaskIds = useUnreadTaskIds(focusedTaskId);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const openNewTaskSignalRef = useRef(openNewTaskSignal);
  useEffect(() => {
    if (
      openNewTaskSignal !== undefined &&
      openNewTaskSignal !== openNewTaskSignalRef.current
    ) {
      openNewTaskSignalRef.current = openNewTaskSignal;
      setNewTaskOpen(true);
    }
  }, [openNewTaskSignal]);
  const [query, setQuery] = useState("");
  // Saved group-collapse state (Orca polish item 2): same localStorage
  // pattern as rail width/collapse below, restored on launch.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    readCollapsedGroups(window.localStorage),
  );
  // Lineage "N children" chip collapse state (see lib/task-lineage.ts),
  // shared with the board via the same localStorage key.
  const [collapsedLineageParents, setCollapsedLineageParents] = useState<
    Set<string>
  >(() => readCollapsedLineageParents(window.localStorage));
  const lineageIndex = useMemo(
    () => buildLineageIndex(flattenBoard(columns).map((row) => row.task)),
    [columns],
  );
  const toggleLineageChildren = useCallback((parentTaskId: string): void => {
    setCollapsedLineageParents((current) => {
      const next = new Set(current);
      if (next.has(parentTaskId)) next.delete(parentTaskId);
      else next.add(parentTaskId);
      storeCollapsedLineageParents(window.localStorage, next);
      return next;
    });
  }, []);
  const [collapsed, setCollapsed] = useState(readStoredCollapsed);
  const [width, setWidth] = useState(readStoredWidth);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Pinned tasks (Orca polish item 3), persisted ids; render above the repo
  // groups via `partitionPinned` below.
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() =>
    readPinnedTaskIds(window.localStorage),
  );
  // Inline rename (item 4): only one row at a time.
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
  // Right-click context menu (item 6).
  const [contextMenu, setContextMenu] = useState<{
    taskId: string;
    x: number;
    y: number;
    worktreePath?: string;
  } | null>(null);
  const rowNodes = useRef(new Map<string, HTMLDivElement>());
  const setRowRef = useCallback(
    (taskId: string, node: HTMLDivElement | null): void => {
      if (node) rowNodes.current.set(taskId, node);
      else rowNodes.current.delete(taskId);
    },
    [],
  );

  const rows = useMemo(
    () => sidebarRows(columns, presence, openedTaskIds),
    [columns, presence, openedTaskIds],
  );
  const groups = useMemo(() => groupRows(rows), [rows]);
  const { pinned, rest: restGroups } = useMemo(
    () => partitionPinned(groups, pinnedIds),
    [groups, pinnedIds],
  );
  const searching = query.trim().length > 0;
  const visiblePinned = useMemo(
    () => pinned.filter((row) => matchesQuery(row, query)),
    [pinned, query],
  );
  const visibleGroups = useMemo(
    () =>
      restGroups
        .map((group) => ({
          ...group,
          rows: group.rows.filter((row) => matchesQuery(row, query)),
        }))
        .filter((group) => group.rows.length > 0),
    [restGroups, query],
  );
  // The rail's full top-to-bottom task order as currently rendered; drives
  // both keyboard cycling (item 5) and the reveal-filter-clear check (item 1).
  const visibleOrder = useMemo(
    () => visibleTaskOrder(visiblePinned, visibleGroups),
    [visiblePinned, visibleGroups],
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
      storeCollapsedGroups(window.localStorage, next);
      return next;
    });
  };

  const togglePin = (taskId: string): void => {
    setPinnedIds((current) => {
      const next = togglePinned(current, taskId);
      storePinnedTaskIds(window.localStorage, next);
      return next;
    });
  };

  // Quiet scroll-to-current: when focus moves to another task, make sure its
  // row is on screen. No button, no flash, no filter-clearing — the reveal
  // feature confused more than it helped (and its flash could stick).
  const prevFocusedRef = useRef(focusedTaskId);
  useEffect(() => {
    if (focusedTaskId && focusedTaskId !== prevFocusedRef.current) {
      const raf = requestAnimationFrame(() => {
        rowNodes.current
          .get(focusedTaskId)
          ?.scrollIntoView({ block: "nearest" });
      });
      prevFocusedRef.current = focusedTaskId;
      return () => cancelAnimationFrame(raf);
    }
    prevFocusedRef.current = focusedTaskId;
  }, [focusedTaskId]);

  // --- Keyboard cycling (Orca polish item 5) --------------------------------
  // Main intercepts Cmd/Ctrl+Shift+Up/Down ahead of the terminal (see
  // main/index.ts's before-input-event handler) and pushes a plain
  // direction; this opens the next/previous row through the same guarded
  // `onSelectTask` path a click uses.
  useEffect(
    () =>
      window.harbormaster.core.onCycleTask((direction) => {
        const next = cycleTaskId(visibleOrder, focusedTaskId, direction);
        if (next) onSelectTask(next);
      }),
    [visibleOrder, focusedTaskId, onSelectTask],
  );

  // --- Inline rename (Orca polish item 4) -----------------------------------
  const commitRename = useCallback((taskId: string, title: string): void => {
    setRenamingTaskId(null);
    void window.harbormaster.core
      .updateTaskState(taskId, { title })
      .catch((error: unknown) => {
        console.error("rename failed:", error);
      });
  }, []);

  // --- Context menu (Orca polish item 6) ------------------------------------
  const openContextMenu = useCallback(
    (taskId: string, x: number, y: number): void => {
      setContextMenu({ taskId, x, y });
      void window.harbormaster.core.getTaskWorkspace(taskId).then((binding) => {
        setContextMenu((current) =>
          current && current.taskId === taskId
            ? {
                ...current,
                ...(binding?.worktreePath
                  ? { worktreePath: binding.worktreePath }
                  : {}),
              }
            : current,
        );
      });
    },
    [],
  );

  function contextMenuItems(task: Task): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      {
        key: "close",
        label: "Close workspace",
        onSelect: () => onCloseTask(task.id),
      },
      {
        key: pinnedIds.has(task.id) ? "unpin" : "pin",
        label: pinnedIds.has(task.id) ? "Unpin" : "Pin",
        onSelect: () => togglePin(task.id),
      },
      {
        key: "rename",
        label: "Rename",
        onSelect: () => setRenamingTaskId(task.id),
      },
      {
        key: "copy-branch",
        label: "Copy branch",
        disabled: !task.branch,
        onSelect: () => {
          if (task.branch) void navigator.clipboard.writeText(task.branch);
        },
      },
    ];
    if (contextMenu?.worktreePath) {
      const worktreePath = contextMenu.worktreePath;
      items.push({
        key: "copy-worktree-path",
        label: "Copy worktree path",
        onSelect: () => void navigator.clipboard.writeText(worktreePath),
      });
      items.push({
        key: "reveal-in-finder",
        label: "Reveal in Finder",
        onSelect: () => {
          void window.harbormaster.shell.revealInFolder(worktreePath);
        },
      });
    }
    const prUrl = pullRequestUrl(task);
    if (prUrl) {
      items.push({
        key: "open-pr",
        label: "Open PR",
        separatorBefore: true,
        onSelect: () => void window.harbormaster.shell.openExternal(prUrl),
      });
    }
    return items;
  }

  const contextMenuRow = contextMenu
    ? rows.find((row) => row.task.id === contextMenu.taskId)
    : undefined;

  function renderRow(
    row: ReturnType<typeof sidebarRows>[number],
    isPinned: boolean,
    lineage?: {
      nested: boolean;
      parentTitle?: string | undefined;
      children?:
        | { count: number; collapsed: boolean; nestedHere: boolean }
        | undefined;
    },
  ) {
    const provenanceTitle = deriveProvenanceLabel(
      row.task,
      (id) => lineageIndex.taskById.get(id)?.title,
    );
    return (
      <SidebarTaskRow
        key={row.task.id}
        row={row}
        selected={focusedTaskId === row.task.id}
        now={now}
        onSelect={onSelectTask}
        onClose={onCloseTask}
        pinned={isPinned}
        unread={unreadTaskIds.has(row.task.id)}
        isRenaming={renamingTaskId === row.task.id}
        onRenameCommit={commitRename}
        onRenameCancel={() => setRenamingTaskId(null)}
        onRenameRequest={setRenamingTaskId}
        onContextMenu={openContextMenu}
        rowRef={setRowRef}
        nested={lineage?.nested ?? false}
        {...(lineage?.parentTitle ? { parentTitle: lineage.parentTitle } : {})}
        {...(provenanceTitle ? { provenanceTitle } : {})}
        {...(lineage?.children
          ? {
              childrenInfo: lineage.children,
              onToggleChildren: () => toggleLineageChildren(row.task.id),
            }
          : {})}
      />
    );
  }

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
      onCreate={onCreateTask}
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
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
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
            No open tasks — pick one from the Board.
          </p>
        )}
        {rows.length > 0 &&
          visiblePinned.length === 0 &&
          visibleGroups.length === 0 && (
            <p
              data-testid="sidebar-search-empty"
              className="px-4 py-4 text-xs text-muted-foreground"
            >
              No tasks match "{query.trim()}".
            </p>
          )}
        {visiblePinned.length > 0 && (
          <section data-testid="sidebar-pinned-section" className="pt-1">
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Pin className="h-3 w-3 shrink-0 rotate-45" aria-hidden />
              <span>Pinned</span>
              <span
                className="ml-auto font-normal tabular-nums text-muted-foreground/70"
                data-testid="sidebar-pinned-count"
              >
                {visiblePinned.length}
              </span>
            </div>
            <div className="border-y border-border/40">
              {layoutLineageRows(
                visiblePinned,
                lineageIndex,
                collapsedLineageParents,
              ).map(({ item, nested, children, parentTitle }) =>
                renderRow(item, true, { nested, parentTitle, children }),
              )}
            </div>
          </section>
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
                <span
                  className={cn(
                    "truncate normal-case",
                    group.label !== "Pinned" &&
                      group.label !== "scratch" &&
                      repoColorClass(group.label),
                  )}
                >
                  {group.label}
                </span>
                <span
                  className="ml-auto font-normal tabular-nums text-muted-foreground/70"
                  data-testid="sidebar-group-count"
                >
                  {group.rows.length}
                </span>
              </button>
              {open && (
                <div className="border-y border-border/40">
                  {layoutLineageRows(
                    group.rows,
                    lineageIndex,
                    collapsedLineageParents,
                  ).map(({ item, nested, children, parentTitle }) =>
                    renderRow(item, false, { nested, parentTitle, children }),
                  )}
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
          <Kbd>{`${modKeyLabel()}N`}</Kbd>
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
          <Kbd>{`${modKeyLabel()}B`}</Kbd>
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
      {contextMenu && contextMenuRow && (
        <SidebarRowContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          testId="sidebar-row-context-menu"
          items={contextMenuItems(contextMenuRow.task)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
