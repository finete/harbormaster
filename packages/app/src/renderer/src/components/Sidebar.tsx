import {
  type Announcements,
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  MeasuringStrategy,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Inbox,
  LayoutGrid,
  ListChecks,
  Pencil,
  Pin,
  Plus,
  Search,
  X,
} from "lucide-react";
import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Task } from "../../../preload/api";
import {
  flattenBoard,
  useBoard,
  useMessagingStates,
  usePresenceMap,
  useUnreadTaskIds,
} from "../core-client";
import { defaultOpenInApp } from "../lib/open-in";
import { modKeyLabel, rulesShortcutLabel } from "../lib/platform";
import { repoColorClass } from "../lib/repo-color";
import { cycleTaskId } from "../lib/sidebar-cycle";
import {
  dragVisibleRows,
  groupSortableId,
  mergeSectionOrder,
  parseSortableId,
  projectGroupDrop,
  projectTaskDrop,
  type SectionRow,
  sameSequence,
  taskSortableId,
} from "../lib/sidebar-order";
import {
  readCollapsedGroups,
  readCollapsedLineageParents,
  readGroupOrder,
  readPinnedTaskIds,
  storeCollapsedGroups,
  storeCollapsedLineageParents,
  storeGroupOrder,
  storePinnedTaskIds,
  togglePinned,
} from "../lib/sidebar-persistence";
import {
  buildLineageIndex,
  type LineageRow,
  layoutLineageRows,
} from "../lib/task-lineage";
import { deriveMessagingChips } from "../lib/task-messaging-chips";
import { deriveProvenanceLabel } from "../lib/task-status-lines";
import { useDragGuards } from "../lib/use-drag-guards";
import { CLOCK_TICK_MS, useNow } from "../lib/use-now";
import {
  openPathIn,
  useLastOpenInAppId,
  useOpenInApps,
} from "../lib/use-open-in";
import { cn } from "../lib/utils";
import {
  type ContextMenuItem,
  SidebarRowContextMenu,
} from "./SidebarRowContextMenu";
import { type RowDragProps, SidebarTaskRow, StatusDot } from "./SidebarTaskRow";
import {
  clampSidebarWidth,
  groupRows,
  matchesQuery,
  partitionPinned,
  pullRequestUrl,
  repoLabel,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  type SidebarRow,
  sidebarRows,
  visibleTaskOrder,
} from "./sidebar-model";
import { SidebarNavItem } from "./ui/sidebar-nav";

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

const PINNED_SECTION = "pinned";
const noop = (): void => {};
const EMPTY_SET: ReadonlySet<string> = new Set();

function groupSection(label: string): string {
  return `group:${label}`;
}

/**
 * Collision for the sidebar's two sortable kinds (R8/R17): only droppables of
 * the dragged item's own kind — and, for tasks, its own section — are
 * candidates, and a pointer outside the union of those candidates (another
 * group, a header, outside the sidebar) yields no collision, i.e. a cancel.
 */
const sidebarCollision: CollisionDetection = (args) => {
  const activeData = args.active.data.current as
    | { kind?: string; section?: string }
    | undefined;
  if (!activeData?.kind) return [];
  const candidates = args.droppableContainers.filter((container) => {
    const data = container.data.current as
      | { kind?: string; section?: string }
      | undefined;
    return (
      data?.kind === activeData.kind &&
      (activeData.kind !== "task" || data?.section === activeData.section)
    );
  });
  if (candidates.length === 0) return [];
  const pointer = args.pointerCoordinates;
  if (pointer) {
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    for (const container of candidates) {
      const rect = args.droppableRects.get(container.id);
      if (!rect) continue;
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
    if (
      pointer.y < top ||
      pointer.y > bottom ||
      pointer.x < left ||
      pointer.x > right
    ) {
      return [];
    }
  }
  // Nearest candidate to the *pointer* (not the dragged rect): the rows hide
  // at drag start, so the dragged node's rect is not a reliable proxy for
  // where the user is pointing, while pointer coordinates always are.
  if (!pointer) {
    return closestCenter({ ...args, droppableContainers: candidates });
  }
  let best: (typeof candidates)[number] | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const container of candidates) {
    const rect = args.droppableRects.get(container.id);
    if (!rect) continue;
    const centerY = rect.top + rect.height / 2;
    const distance =
      pointer.y >= rect.top && pointer.y <= rect.bottom
        ? Math.abs(pointer.y - centerY) / 1000
        : Math.min(
            Math.abs(pointer.y - rect.top),
            Math.abs(pointer.y - rect.bottom),
          );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = container;
    }
  }
  return best ? [{ id: best.id }] : [];
};

/** One draggable task row (R7): sortable id `task:<id>`, tagged with its section for collision filtering. */
function SortableTaskRow({
  section,
  disabled,
  rowProps,
}: {
  section: string;
  disabled: boolean;
  rowProps: Parameters<typeof SidebarTaskRow>[0];
}): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: taskSortableId(rowProps.row.task.id),
    data: { kind: "task", section },
    disabled,
    animateLayoutChanges: () => false,
  });
  // dnd-kit's `aria-disabled` would mark every control inside the row (the
  // rename input, buttons) disabled for assistive tech while dragging is
  // merely off (search/rename); drop it so disabled rows behave as today.
  const { "aria-disabled": _ariaDisabled, ...rowAttributes } = attributes;
  const drag: RowDragProps = {
    setNodeRef,
    // Translate, never Transform: Transform scales variable-height rows (R22).
    style: { transform: CSS.Translate.toString(transform), transition },
    attributes: rowAttributes,
    listeners,
    isDragging,
  };
  return <SidebarTaskRow {...rowProps} drag={drag} />;
}

/** One draggable repo group (R17): the whole section moves, the header is the drag handle. */
function SortableGroupSection({
  label,
  disabled,
  header,
  children,
}: {
  label: string;
  disabled: boolean;
  header: (drag: {
    attributes: Omit<
      ReturnType<typeof useSortable>["attributes"],
      "aria-disabled"
    >;
    listeners: ReturnType<typeof useSortable>["listeners"];
    setActivatorNodeRef: (node: HTMLElement | null) => void;
  }) => ReactNode;
  children: ReactNode;
}): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: groupSortableId(label),
    data: { kind: "group" },
    disabled,
    animateLayoutChanges: () => false,
  });
  const { "aria-disabled": _ariaDisabled, ...headerAttributes } = attributes;
  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid={`sidebar-group-${label}`}
      className={cn("pt-1", isDragging && "opacity-40")}
    >
      {header({
        attributes: headerAttributes,
        listeners,
        setActivatorNodeRef,
      })}
      {children}
    </section>
  );
}

/**
 * Workspace-view task rail, modeled on a terminal app's workspace sidebar: the rail lists only
 * *open* task workspaces (`openedTaskIds`, owned by App.tsx), not the full
 * board inventory -- the Board stays the full inventory. Rows are grouped
 * by repository (collapsible, "scratch" last by default), kept in a FIXED,
 * user-owned order that only a drag rewrites (see sidebar-model.ts and
 * /docs/design-decisions.md "sidebar rail order"): rows reorder within their section, nested
 * children can detach/re-attach, and repo groups reorder by their header.
 * Keyboard sorting is deliberately out of scope: dnd-kit's KeyboardSensor
 * activates on Enter/Space, which would steal row activation (no
 * KeyboardSensor is registered; announcements below serve pointer drags). A
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
  taskOrder,
  onTaskOrderChange,
  detachedIds,
  onDetachedChange,
  onSelectTask,
  onCloseTask,
  onShowBoard,
  onOpenInbox,
  inboxCount,
  inboxActive,
  onOpenRules,
  rulesActive,
  onNewTask,
  draftLabel,
  draftFocused,
  onSelectDraft,
  onCloseDraft,
}: {
  focusedTaskId: string | null;
  openedTaskIds: ReadonlySet<string>;
  /** Global user-owned task order (App's `useSidebarOrder`). */
  taskOrder: readonly string[];
  onTaskOrderChange: (order: readonly string[]) => void;
  /** Children dragged out of their parent's block (rendered top-level). */
  detachedIds: ReadonlySet<string>;
  onDetachedChange: (ids: ReadonlySet<string>) => void;
  onSelectTask: (taskId: string) => void;
  onCloseTask: (taskId: string) => void;
  onShowBoard: () => void;
  /** Toggle the inbox view (App owns it; same as Cmd+I). */
  onOpenInbox: () => void;
  /** Priority inbox items: the Inbox row's badge (docs/release-plan.md "Inbox"). */
  inboxCount: number;
  /** The inbox view is showing. */
  inboxActive: boolean;
  /** Toggle the Rules page (App owns it; same as Cmd/Ctrl+Shift+R). */
  onOpenRules: () => void;
  /** The Rules page is showing. */
  rulesActive: boolean;
  /** Open/focus THE new-task draft (same path as Cmd/Ctrl+N). */
  onNewTask: () => void;
  /** Live label of the new-task draft row; `null` = no draft exists. */
  draftLabel: string | null;
  draftFocused: boolean;
  onSelectDraft: () => void;
  onCloseDraft: () => void;
}): JSX.Element {
  const columns = useBoard();
  const inboxTitle =
    inboxCount > 0
      ? `Inbox: ${inboxCount} need${inboxCount === 1 ? "s" : ""} you (${modKeyLabel()}I)`
      : `Inbox: nothing needs you (${modKeyLabel()}I)`;
  const rulesShortcut = rulesShortcutLabel();
  const rulesTitle = `Rules: what each rule says and did (${rulesShortcut})`;
  const presence = usePresenceMap();
  const now = useNow(CLOCK_TICK_MS);
  const messagingStates = useMessagingStates();
  const unreadTaskIds = useUnreadTaskIds(focusedTaskId);
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
  const [groupOrder, setGroupOrder] = useState<readonly string[]>(() =>
    readGroupOrder(window.localStorage),
  );
  // What is being dragged right now (null = nothing). `projectedAttached`
  // is the live attach/detach projection for the dragged child's in-flow
  // placeholder (R14); it is view state only — nothing is committed until drop.
  const [drag, setDrag] = useState<
    | { kind: "task"; taskId: string; section: string }
    | { kind: "group"; label: string }
    | null
  >(null);
  const [projectedAttached, setProjectedAttached] = useState<boolean | null>(
    null,
  );
  // Where the dragged node sat when the drag began (before any row hid).
  // dnd-kit measures the active node only after the layout override has
  // applied, so it reports the *moved* rect; the modifier below re-anchors
  // overlay to the pointer using this origin (collision uses the pointer itself).
  const dragOriginRef = useRef<{ left: number; top: number } | null>(null);
  const alignToDragOrigin: Modifier = useCallback(
    ({ transform, activeNodeRect }) => {
      const origin = dragOriginRef.current;
      if (!origin || !activeNodeRect) return transform;
      return {
        ...transform,
        x: transform.x + origin.left - activeNodeRect.left,
        y: transform.y + origin.top - activeNodeRect.top,
      };
    },
    [],
  );
  const dragGuards = useDragGuards();
  // Drag-only layout overrides (hidden nested blocks, collapsed group bodies)
  // apply from the first render of a drag, so dnd-kit measures the dragged
  // node, the overlay and every droppable against one consistent layout.
  const layoutHidden = drag !== null;
  const sensors = useSensors(
    // Board parity: 4px before a drag starts, so a plain click still
    // selects the row; dnd-kit's activator ignores non-primary buttons, so
    // right-click (context menu) never starts one.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
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
  const groups = useMemo(
    () => groupRows(rows, taskOrder, groupOrder),
    [rows, taskOrder, groupOrder],
  );
  const { pinned, rest: restGroups } = useMemo(
    () => partitionPinned(groups, pinnedIds, taskOrder),
    [groups, pinnedIds, taskOrder],
  );
  const layoutOptions = useMemo(
    () => ({ detachedIds, siblingOrder: taskOrder }),
    [detachedIds, taskOrder],
  );
  /** A section's rows in rendered order (children under parents, sibling order from the task order). */
  const layoutSection = useCallback(
    (sectionRows: SidebarRow[], collapsedParents: ReadonlySet<string>) =>
      layoutLineageRows(
        sectionRows,
        lineageIndex,
        collapsedParents,
        layoutOptions,
      ),
    [lineageIndex, layoutOptions],
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
  // Rows are laid out with nothing collapsed so cycling/scroll order matches
  // the rail's rendered order (children directly under their parent).
  const visibleOrder = useMemo(() => {
    const laidOut = (sectionRows: SidebarRow[]): SidebarRow[] =>
      layoutSection(sectionRows, EMPTY_SET).map((entry) => entry.item);
    return visibleTaskOrder(
      laidOut(visiblePinned),
      visibleGroups.map((group) => ({ ...group, rows: laidOut(group.rows) })),
    );
  }, [visiblePinned, visibleGroups, layoutSection]);
  // The collapsed icon rail walks the same order: pinned first, then groups.
  const railRows = useMemo(() => {
    const laidOut = (sectionRows: SidebarRow[]): SidebarRow[] =>
      layoutSection(sectionRows, EMPTY_SET).map((entry) => entry.item);
    return [
      ...laidOut(pinned),
      ...restGroups.flatMap((group) => laidOut(group.rows)),
    ];
  }, [pinned, restGroups, layoutSection]);

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

  // "Open in <app>" for a row's worktree (see components/OpenInButton.tsx).
  const openInApps = useOpenInApps();
  const lastOpenInAppId = useLastOpenInAppId();
  const openInDefault = defaultOpenInApp(openInApps, lastOpenInAppId);

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
      if (openInDefault) {
        items.push({
          key: "open-in-default",
          label: `Open in ${openInDefault.label}`,
          onSelect: () => void openPathIn(worktreePath, openInDefault),
        });
        items.push({
          key: "open-in",
          label: "Open in…",
          onSelect: () => {},
          submenu: openInApps.map((openInApp) => ({
            key: `open-in-${openInApp.id}`,
            label: openInApp.label,
            onSelect: () => void openPathIn(worktreePath, openInApp),
          })),
        });
      }
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

  // --- Drag and drop (/docs/design-decisions.md "sidebar rail order") --------------------------
  // No dragging while filtering (a reordered filtered list is ambiguous) or
  // renaming; the collapsed icon rail renders no sortables at all.
  const dragDisabled = searching || renamingTaskId !== null;

  /** The rows of `section` (pinned, or `group:<label>`), unfiltered because dragging is off while searching. */
  const sectionRowsOf = (section: string): SidebarRow[] =>
    section === PINNED_SECTION
      ? visiblePinned
      : (visibleGroups.find((group) => groupSection(group.label) === section)
          ?.rows ?? []);

  /** A section's fully expanded layout as pure drag rows (collapse ignored). */
  const toSectionRows = (laid: LineageRow<SidebarRow>[]): SectionRow[] => {
    const ids = new Set(laid.map((entry) => entry.item.task.id));
    return laid.map((entry) => {
      const parentId = entry.item.task.parentTaskId;
      return {
        id: entry.item.task.id,
        nested: entry.nested,
        parentId: parentId && ids.has(parentId) ? parentId : undefined,
      };
    });
  };
  const expandedSectionRows = (section: string): SectionRow[] =>
    toSectionRows(layoutSection(sectionRowsOf(section), EMPTY_SET));

  const titleOf = (taskId: string): string =>
    rows.find((row) => row.task.id === taskId)?.task.title ?? "task";
  const sectionName = (section: string | undefined): string =>
    !section || section === PINNED_SECTION
      ? "Pinned"
      : section.slice("group:".length);
  const describeSortable = (id: string | number): string => {
    const parsed = parseSortableId(id);
    if (!parsed) return "an item";
    return parsed.kind === "task"
      ? titleOf(parsed.value)
      : `${parsed.value} group`;
  };
  const sectionOfTask = (taskId: string): string => {
    const row = rows.find((entry) => entry.task.id === taskId);
    if (!row) return PINNED_SECTION;
    return pinnedIds.has(taskId)
      ? PINNED_SECTION
      : groupSection(repoLabel(row.task));
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${describeSortable(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${describeSortable(active.id)} is over ${describeSortable(over.id)}.`
        : `${describeSortable(active.id)} is no longer over a valid position.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${describeSortable(active.id)} dropped ${
            parseSortableId(active.id)?.kind === "task"
              ? `in ${sectionName(sectionOfTask(parseSortableId(active.id)?.value ?? ""))}`
              : "among the groups"
          }.`
        : `${describeSortable(active.id)} dropped outside its list; nothing moved.`,
    onDragCancel: ({ active }) =>
      `Moving ${describeSortable(active.id)} was cancelled; nothing moved.`,
  };

  const resetDrag = (): void => {
    dragOriginRef.current = null;
    setDrag(null);
    setProjectedAttached(null);
  };

  const handleDragStart = (event: DragStartEvent): void => {
    dragGuards.beginDrag();
    const parsed = parseSortableId(event.active.id);
    if (!parsed) return;
    setProjectedAttached(null);
    // dnd-kit measures the active node late (after the override below), so
    // read where it sits right now straight from the DOM: the sortable node
    // is the row's outer wrapper / the group <section>.
    const originNode =
      parsed.kind === "group"
        ? document.querySelector(
            `[data-testid="sidebar-group-${parsed.value}"]`,
          )
        : rowNodes.current.get(parsed.value)?.parentElement;
    const originRect = originNode?.getBoundingClientRect();
    dragOriginRef.current = originRect
      ? { left: originRect.left, top: originRect.top }
      : null;
    if (parsed.kind === "group") {
      setDrag({ kind: "group", label: parsed.value });
    } else {
      const section = (
        event.active.data.current as { section?: string } | undefined
      )?.section;
      setDrag({
        kind: "task",
        taskId: parsed.value,
        section: section ?? sectionOfTask(parsed.value),
      });
    }
  };

  // Live attach/detach preview for the placeholder's indentation (R14).
  // Only view state: the order itself is committed once, in onDragEnd (R9).
  const handleDragMove = (event: DragMoveEvent): void => {
    if (drag?.kind !== "task" || !event.over) return;
    const over = parseSortableId(event.over.id);
    if (over?.kind !== "task") return;
    const projection = projectTaskDrop(
      expandedSectionRows(drag.section),
      drag.taskId,
      over.value,
      event.delta.x,
    );
    setProjectedAttached(projection?.attached ?? null);
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    dragGuards.endDrag();
    const current = drag;
    resetDrag();
    // R24: nothing to commit when the dragged item vanished mid-drag, and
    // R8: a drop outside the section's candidates has no `over` (a cancel).
    if (!current || !event.over) return;
    const over = parseSortableId(event.over.id);
    if (!over) return;

    if (current.kind === "group") {
      if (over.kind !== "group") return;
      const labels = visibleGroups.map((group) => group.label);
      if (!labels.includes(current.label)) return;
      const next = projectGroupDrop(labels, current.label, over.value);
      if (!next) return; // R19: dropped where it started
      const merged = mergeSectionOrder(
        groupOrder,
        groups.map((group) => group.label),
        next,
      );
      if (sameSequence(merged, groupOrder)) return;
      setGroupOrder(merged);
      storeGroupOrder(window.localStorage, merged);
      return;
    }

    if (over.kind !== "task") return;
    if (!rows.some((row) => row.task.id === current.taskId)) return;
    const full = expandedSectionRows(current.section);
    const projection = projectTaskDrop(
      full,
      current.taskId,
      over.value,
      event.delta.x,
    );
    if (!projection?.changed) return; // R19: no-op, write nothing
    const merged = mergeSectionOrder(
      taskOrder,
      rows.map((row) => row.task.id),
      projection.sequence,
    );
    if (!sameSequence(merged, taskOrder)) onTaskOrderChange(merged);

    const parentId = full.find((row) => row.id === current.taskId)?.parentId;
    if (projection.attached !== null && parentId !== undefined) {
      const wasDetached = detachedIds.has(current.taskId);
      if (projection.attached && wasDetached) {
        const next = new Set(detachedIds);
        next.delete(current.taskId);
        onDetachedChange(next);
        // Re-attaching under a collapsed parent expands it so the row
        // doesn't vanish (R13).
        if (collapsedLineageParents.has(parentId)) {
          setCollapsedLineageParents((collapsedNow) => {
            const expanded = new Set(collapsedNow);
            expanded.delete(parentId);
            storeCollapsedLineageParents(window.localStorage, expanded);
            return expanded;
          });
        }
      } else if (!projection.attached && !wasDetached) {
        onDetachedChange(new Set(detachedIds).add(current.taskId));
      }
    }
  };

  const handleDragCancel = (): void => {
    dragGuards.endDrag();
    resetDrag();
  };

  // R24: the dragged item disappeared (closed elsewhere, archived): drop the
  // drag-only render overrides; the eventual drop finds no drag and writes nothing.
  const dragTargetGone =
    drag?.kind === "task"
      ? !rows.some((row) => row.task.id === drag.taskId)
      : drag?.kind === "group"
        ? !visibleGroups.some((group) => group.label === drag.label)
        : false;
  useEffect(() => {
    if (dragTargetGone) {
      setDrag(null);
      setProjectedAttached(null);
    }
  }, [dragTargetGone]);

  const overlayRow =
    drag?.kind === "task"
      ? rows.find((row) => row.task.id === drag.taskId)
      : undefined;
  const overlayGroup =
    drag?.kind === "group"
      ? visibleGroups.find((group) => group.label === drag.label)
      : undefined;

  const handleSelect = useCallback(
    (taskId: string): void => {
      if (dragGuards.consumeDragClick()) return;
      onSelectTask(taskId);
    },
    [dragGuards, onSelectTask],
  );

  function renderRow(
    row: SidebarRow,
    isPinned: boolean,
    section: string,
    lineage: {
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
    // The in-flow placeholder shows the *projected* indentation (R14).
    const isActive = drag?.kind === "task" && drag.taskId === row.task.id;
    const nested =
      isActive && projectedAttached !== null
        ? projectedAttached
        : lineage.nested;
    return (
      <SortableTaskRow
        key={row.task.id}
        section={section}
        disabled={dragDisabled}
        rowProps={{
          row,
          selected: focusedTaskId === row.task.id,
          now,
          onSelect: handleSelect,
          onClose: onCloseTask,
          pinned: isPinned,
          unread: unreadTaskIds.has(row.task.id),
          isRenaming: renamingTaskId === row.task.id,
          onRenameCommit: commitRename,
          onRenameCancel: () => setRenamingTaskId(null),
          onRenameRequest: setRenamingTaskId,
          onContextMenu: openContextMenu,
          rowRef: setRowRef,
          nested,
          ...(lineage.parentTitle ? { parentTitle: lineage.parentTitle } : {}),
          ...(provenanceTitle ? { provenanceTitle } : {}),
          ...(lineage.children
            ? {
                childrenInfo: lineage.children,
                onToggleChildren: () => toggleLineageChildren(row.task.id),
              }
            : {}),
        }}
      />
    );
  }

  /**
   * One section's rows inside its own SortableContext (R7). While a task drag
   * is active in this section, every nested block is hidden except the dragged
   * child's own parent's block, and the dragged row's own children are hidden
   * (R10/R15) — a drag-only render override; saved collapse state is untouched.
   */
  function renderSectionRows(
    section: string,
    sectionRows: SidebarRow[],
    isPinned: boolean,
  ) {
    const draggingHere =
      layoutHidden && drag?.kind === "task" && drag.section === section;
    const laid = layoutSection(
      sectionRows,
      draggingHere ? EMPTY_SET : collapsedLineageParents,
    );
    let shown = laid;
    if (draggingHere && drag?.kind === "task") {
      const visible = new Set(
        dragVisibleRows(toSectionRows(laid), drag.taskId).map((r) => r.id),
      );
      shown = laid.filter((entry) => visible.has(entry.item.task.id));
    }
    return (
      <SortableContext
        items={shown.map((entry) => taskSortableId(entry.item.task.id))}
        strategy={verticalListSortingStrategy}
      >
        {shown.map(({ item, nested, children, parentTitle }) =>
          renderRow(item, isPinned, section, { nested, parentTitle, children }),
        )}
      </SortableContext>
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
    // The Escape that just cancelled a drag must not also clear the filter.
    if (dragGuards.dragKeyGuardRef.current) return;
    event.preventDefault();
    if (query) setQuery("");
    else searchRef.current?.blur();
  };

  if (collapsed) {
    return (
      <div
        data-testid="sidebar"
        data-collapsed="true"
        className="flex h-full w-12 shrink-0 flex-col items-center border-r border-border bg-chrome"
      >
        <button
          type="button"
          data-testid="sidebar-collapse"
          aria-expanded={false}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          onClick={toggleCollapsed}
          className="mt-2 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-[120ms] ease-out hover:bg-accent hover:text-foreground"
        >
          <ChevronsRight className="h-4 w-4" aria-hidden />
        </button>
        <nav
          aria-label="Main"
          className="mt-2 flex w-full flex-col items-center gap-0.5 border-b border-border pb-2"
        >
          <SidebarNavItem
            compact
            icon={<Plus aria-hidden />}
            label="New task"
            shortcut={`${modKeyLabel()}N`}
            onClick={onNewTask}
            testId="sidebar-new-task-button"
          />
          <SidebarNavItem
            compact
            icon={<LayoutGrid aria-hidden />}
            label="Board"
            shortcut={`${modKeyLabel()}B`}
            onClick={onShowBoard}
            testId="board-button"
          />
          <SidebarNavItem
            compact
            icon={<ListChecks aria-hidden />}
            label="Rules"
            active={rulesActive}
            title={rulesTitle}
            onClick={onOpenRules}
            testId="rules-button-compact"
          />
          <SidebarNavItem
            compact
            icon={<Inbox aria-hidden />}
            label="Inbox"
            badge={inboxCount}
            active={inboxActive}
            title={inboxTitle}
            onClick={onOpenInbox}
            testId="inbox-button-compact"
          />
        </nav>
        <div className="mt-1 flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-1">
          {draftLabel !== null && (
            <button
              type="button"
              data-testid="sidebar-collapsed-draft"
              aria-pressed={draftFocused}
              aria-label={draftLabel}
              title={draftLabel}
              onClick={onSelectDraft}
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-[120ms] ease-out hover:bg-accent",
                draftFocused && "bg-accent text-foreground ring-1 ring-primary",
              )}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
          {railRows.map((row) => (
            <button
              key={row.task.id}
              type="button"
              data-testid={`sidebar-collapsed-row-${row.task.id}`}
              aria-pressed={focusedTaskId === row.task.id}
              aria-label={row.task.title}
              title={`${row.task.title} · ${repoLabel(row.task)}`}
              onClick={() => onSelectTask(row.task.id)}
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-[120ms] ease-out hover:bg-accent",
                focusedTaskId === row.task.id &&
                  "bg-accent ring-1 ring-primary",
              )}
            >
              <StatusDot
                presence={row.presence}
                waitingOnParent={
                  deriveMessagingChips(messagingStates.get(row.task.id), now)
                    .suppressAttention
                }
              />
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="sidebar"
      data-collapsed="false"
      style={{ width }}
      className={cn(
        "relative flex h-full shrink-0 flex-col border-r border-border bg-chrome",
        resizing && "select-none",
      )}
    >
      <nav
        aria-label="Main"
        className="flex flex-col gap-0.5 border-b border-border px-2 pb-2 pt-2"
      >
        <SidebarNavItem
          icon={<Plus aria-hidden />}
          label="New task"
          shortcut={`${modKeyLabel()}N`}
          onClick={onNewTask}
          testId="sidebar-new-task-button"
        />
        <SidebarNavItem
          icon={<LayoutGrid aria-hidden />}
          label="Board"
          shortcut={`${modKeyLabel()}B`}
          onClick={onShowBoard}
          testId="board-button"
        />
        <SidebarNavItem
          icon={<ListChecks aria-hidden />}
          label="Rules"
          shortcut={rulesShortcut}
          active={rulesActive}
          title={rulesTitle}
          onClick={onOpenRules}
          testId="rules-button"
        />
        <SidebarNavItem
          icon={<Inbox aria-hidden />}
          label="Inbox"
          shortcut={`${modKeyLabel()}I`}
          badge={inboxCount}
          active={inboxActive}
          title={inboxTitle}
          onClick={onOpenInbox}
          testId="inbox-button"
        />
      </nav>
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-[120ms] ease-out hover:bg-accent hover:text-foreground"
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
            className="h-8 w-full rounded-lg border border-input bg-background pl-8 pr-7 text-[13px] text-foreground transition-colors duration-[120ms] ease-out placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          )}
        </div>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={sidebarCollision}
        // Rows hide/show at drag start (R10/R15/R18): stale rects would
        // mis-target drops, so droppables are re-measured continuously.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              "Drag with a pointer to reorder this item within its list; Escape cancels. Keyboard reordering is not supported.",
          },
        }}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div
          data-testid="sidebar-list"
          data-drag-layout={layoutHidden ? drag?.kind : undefined}
          className="min-h-0 flex-1 overflow-y-auto pb-2"
        >
          {draftLabel !== null && (
            <div
              data-testid="sidebar-draft-row"
              data-focused={draftFocused}
              className={cn(
                "group flex items-center gap-2 border-l-2 border-dashed border-primary/50 px-3 py-1.5 text-sm italic text-muted-foreground transition-colors duration-[120ms] ease-out hover:bg-accent/60",
                draftFocused &&
                  "border-solid border-primary bg-accent text-foreground",
              )}
            >
              <button
                type="button"
                data-testid="sidebar-draft-select"
                onClick={onSelectDraft}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{draftLabel}</span>
              </button>
              <button
                type="button"
                data-testid="sidebar-draft-close"
                aria-label="Discard draft"
                title="Close draft"
                onClick={onCloseDraft}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-60 hover:bg-accent hover:opacity-100"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          )}
          {rows.length === 0 && draftLabel === null && (
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
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                {renderSectionRows(PINNED_SECTION, visiblePinned, true)}
              </div>
            </section>
          )}
          <SortableContext
            items={visibleGroups.map((group) => groupSortableId(group.label))}
            strategy={verticalListSortingStrategy}
          >
            {visibleGroups.map((group) => {
              // A live filter always shows its matches, even inside a group
              // the user collapsed; while a group is dragged every body
              // renders collapsed (R18) without touching the saved state.
              const open =
                !(layoutHidden && drag?.kind === "group") &&
                (searching || !collapsedGroups.has(group.label));
              return (
                <SortableGroupSection
                  key={group.label}
                  label={group.label}
                  disabled={dragDisabled}
                  header={({ attributes, listeners, setActivatorNodeRef }) => (
                    <button
                      type="button"
                      {...attributes}
                      {...listeners}
                      ref={setActivatorNodeRef}
                      data-testid={`sidebar-group-toggle-${group.label}`}
                      aria-expanded={open}
                      aria-roledescription="sortable group"
                      onClick={() => {
                        if (dragGuards.consumeDragClick()) return;
                        toggleGroup(group.label);
                      }}
                      className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors duration-[120ms] ease-out hover:text-foreground"
                    >
                      {open ? (
                        <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
                      ) : (
                        <ChevronRight
                          className="h-3 w-3 shrink-0"
                          aria-hidden
                        />
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
                  )}
                >
                  {open && (
                    <div className="border-y border-border/40">
                      {renderSectionRows(
                        groupSection(group.label),
                        group.rows,
                        false,
                      )}
                    </div>
                  )}
                </SortableGroupSection>
              );
            })}
          </SortableContext>
        </div>
        {/* Portaled out of the overflow-y-auto scroller (R22): never clipped,
          never stretches the list; the in-flow source row just dims. */}
        {createPortal(
          <DragOverlay dropAnimation={null} modifiers={[alignToDragOrigin]}>
            {overlayRow ? (
              <SidebarTaskRow
                overlay
                row={overlayRow}
                selected={focusedTaskId === overlayRow.task.id}
                now={now}
                onSelect={noop}
                onClose={noop}
                pinned={pinnedIds.has(overlayRow.task.id)}
              />
            ) : overlayGroup ? (
              <div
                data-testid="sidebar-drag-overlay-group"
                className="flex items-center gap-1.5 rounded-lg border border-primary bg-card px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate normal-case">
                  {overlayGroup.label}
                </span>
                <span className="ml-auto font-normal tabular-nums">
                  {overlayGroup.rows.length}
                </span>
              </div>
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
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
