import { ChevronDown, ChevronRight, Pin, X } from "lucide-react";
import type {
  CSSProperties,
  HTMLAttributes,
  JSX,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
} from "react";
import { useEffect, useRef, useState } from "react";
import type { Task } from "../../../preload/api";
import { useMessagingStates } from "../core-client";
import { taskAgentLabel } from "../lib/task-agent";
import {
  deriveMessagingChips,
  loopCapLabel,
} from "../lib/task-messaging-chips";
import {
  deriveLaunchMarker,
  deriveOutcomeLine,
  derivePresenceActivity,
} from "../lib/task-status-lines";
import { cn } from "../lib/utils";
import { pushToast } from "../toast";
import { prBadgeLabel, prBadgeVariant } from "./pr-badge";
import {
  activityTimestamp,
  pullRequestUrl,
  relativeTime,
  type SidebarRow,
  type StateTone,
  stateChipLabel,
} from "./sidebar-model";
import { WorkingSpinner } from "./ui/working-spinner";

/**
 * Bordered chip tones from the design system's status tokens only: neutral
 * grey ramp for backlog/dev, needs-you amber for awaiting (blocked), ok mint
 * for done ("done, wants a look").
 */
const NEUTRAL_CHIP = "border-border bg-muted text-muted-foreground";
const NEEDS_YOU_CHIP =
  "border-status-needsYou/40 bg-status-needsYou/10 text-status-needsYou";
const OK_CHIP = "border-status-ok/40 bg-status-ok/10 text-status-ok";
const ERROR_CHIP =
  "border-status-error/40 bg-status-error/10 text-status-error";

const STATE_CHIP_CLASS: Record<StateTone, string> = {
  backlog: NEUTRAL_CHIP,
  dev: "border-border bg-muted text-foreground",
  awaiting: NEEDS_YOU_CHIP,
  done: OK_CHIP,
};

const PR_CHIP_CLASS: Record<ReturnType<typeof prBadgeVariant>, string> = {
  success: "border-status-ok/50 text-status-ok hover:bg-status-ok/15",
  draft: "border-border text-muted-foreground hover:bg-accent",
  merged: "border-status-ok/35 text-status-ok hover:bg-status-ok/10",
  closed: "border-status-error/45 text-status-error hover:bg-status-error/15",
  changes:
    "border-status-needsYou/45 text-status-needsYou hover:bg-status-needsYou/15",
};

const CHIP_BASE =
  "inline-flex h-[18px] shrink-0 items-center rounded border px-1.5 text-[10px] font-medium leading-none";

function RunningDot(): JSX.Element {
  return (
    <span
      className="flex h-2.5 w-2.5 shrink-0 items-center justify-center"
      data-testid="sidebar-row-spinner"
      data-status="running"
      role="img"
      aria-label="Agent working"
    >
      <WorkingSpinner className="h-2.5 w-2.5" />
    </span>
  );
}

/**
 * Live-presence indicator. Keeps the pre-redesign test ids so e2e coverage
 * carries over: `sidebar-row-spinner` while an agent turn runs (the yellow
 * stepped spinner, see WorkingSpinner), `sidebar-row-attention-dot` for
 * live-but-idle — pi-home's ● "your move": the agent finished its loop and
 * waits on you, so it gets the mint call-to-action color with a ring — and
 * `sidebar-row-status-dot` otherwise (muted gray).
 */
export function StatusDot({
  presence,
  waitingOnParent = false,
}: {
  presence: SidebarRow["presence"];
  /** Live but idle because it asked its parent (task messaging): a neutral dot instead of the amber "your move" one. */
  waitingOnParent?: boolean;
}): JSX.Element {
  const activity = derivePresenceActivity(presence, waitingOnParent);
  if (activity === "working") {
    return <RunningDot />;
  }
  if (activity === "error") {
    return (
      <span
        className="flex h-2.5 w-2.5 shrink-0 items-center justify-center"
        data-testid="sidebar-row-error-dot"
        data-status="error"
        role="img"
        aria-label="Agent stopped with an error"
      >
        <span className="h-2 w-2 rounded-full bg-status-error" />
      </span>
    );
  }
  if (activity === "idle" && !waitingOnParent) {
    return (
      <span
        className="flex h-2.5 w-2.5 shrink-0 items-center justify-center"
        data-testid="sidebar-row-idle-dot"
        data-status="idle"
        role="img"
        aria-label="Agent idle"
      >
        <span className="h-2 w-2 rounded-full bg-status-ok/70" />
      </span>
    );
  }
  if (presence?.live && waitingOnParent) {
    return (
      <span
        className="flex h-2.5 w-2.5 shrink-0 items-center justify-center"
        data-testid="sidebar-row-waiting-dot"
        data-status="waiting-on-parent"
        role="img"
        aria-label="Waiting on parent"
      >
        <span className="h-2 w-2 rounded-full bg-muted-foreground" />
      </span>
    );
  }
  if (presence?.live) {
    return (
      <span
        className="flex h-2.5 w-2.5 shrink-0 items-center justify-center"
        data-testid="sidebar-row-attention-dot"
        data-status="attention"
        role="img"
        aria-label="Your move: agent waiting for input"
      >
        <span className="h-2 w-2 rounded-full bg-status-ok ring-2 ring-status-ok/30" />
      </span>
    );
  }
  return (
    <span
      className="flex h-2.5 w-2.5 shrink-0 items-center justify-center"
      data-testid="sidebar-row-status-dot"
      data-status="offline"
      role="img"
      aria-label="No agent attached"
    >
      <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
    </span>
  );
}

function PrChip({ task }: { task: Task }): JSX.Element | null {
  const pr = task.pr;
  if (!pr) return null;
  const url = pullRequestUrl(task);
  const open = (event: MouseEvent<HTMLButtonElement>): void => {
    // The chip sits inside the row's own click target; never let opening
    // the PR also focus/attach the task.
    event.stopPropagation();
    if (!url) return;
    void window.harbormaster.shell
      .openExternal(url)
      .then((opened) => {
        if (!opened) {
          pushToast(
            `Not opening ${url}: only github.com links are allowed.`,
            "warning",
          );
        }
      })
      .catch((error: unknown) => {
        console.error("openExternal failed:", error);
      });
  };
  return (
    <button
      type="button"
      data-testid="pr-chip"
      data-pr-url={url ?? ""}
      data-role={pr.role ?? "author"}
      onClick={open}
      onPointerDown={stopPointerDown}
      onKeyDown={(event) => event.stopPropagation()}
      disabled={!url}
      title={`${prBadgeLabel(pr)}${url ? " — open on GitHub" : ""}`}
      className={cn(
        CHIP_BASE,
        "cursor-pointer font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-default",
        PR_CHIP_CLASS[prBadgeVariant(pr)],
      )}
    >
      {pr.role === "reviewer" ? `review #${pr.number}` : `#${pr.number}`}
    </button>
  );
}

/** Pointer-down on an inner control must not start a row drag (R20): the control's own click keeps working. */
const stopPointerDown = (event: PointerEvent<HTMLElement>): void =>
  event.stopPropagation();

/** dnd-kit wiring handed down by Sidebar's `SortableTaskRow` (R7/R20/R22). */
export interface RowDragProps {
  /** Ref for the row's outer wrapper (the sortable node). */
  setNodeRef: (node: HTMLElement | null) => void;
  style: CSSProperties;
  /** dnd-kit aria attributes (spread before the row's own, so `aria-pressed` still wins). */
  attributes: HTMLAttributes<HTMLElement>;
  /** Pointer listeners; undefined while dragging is disabled (search, rename). */
  listeners: Record<string, unknown> | undefined;
  /** This row is the in-flow placeholder of the active drag: dimmed. */
  isDragging: boolean;
}

/**
 * One task row: status dot + semibold title + right-aligned relative time;
 * muted mono branch subline with the board-position chip and PR chip; and
 * (only while an agent is attached) an activity line. Rows are separated by
 * a full-width hairline; the selected row gets a rounded subtle highlight.
 *
 * Closable, cmux-style: hovering reveals a small ✕ that replaces the
 * relative time (pure CSS `group-hover`, no hover state needed) and closes
 * just this task's workspace — never the task itself, see App.tsx's
 * `requestCloseTask`. Middle-clicking anywhere on the row does the same;
 * the matching `onPointerDown` suppresses the browser's default middle-click
 * autoscroll so the click actually lands.
 */
export function SidebarTaskRow({
  row,
  selected,
  now,
  onSelect,
  onClose,
  pinned = false,
  unread = false,
  isRenaming = false,
  onRenameCommit,
  onRenameCancel,
  onRenameRequest,
  onContextMenu,
  rowRef,
  nested = false,
  parentTitle,
  provenanceTitle,
  childrenInfo,
  onToggleChildren,
  drag,
  overlay = false,
}: {
  row: SidebarRow;
  selected: boolean;
  now: number;
  onSelect: (taskId: string) => void;
  onClose: (taskId: string) => void;
  /** Rendered in the Pinned section (Orca polish item 3); shows a small pin glyph. */
  pinned?: boolean;
  /** "Finished while you weren't looking" (Orca polish item 7): dot accent + bolder title, cleared on focus. */
  unread?: boolean;
  /** Inline-rename mode (Orca polish item 4): swaps the title for a text input. */
  isRenaming?: boolean;
  onRenameCommit?: (taskId: string, title: string) => void;
  onRenameCancel?: () => void;
  /** Double-clicking the title asks the owning Sidebar to enter rename mode for this row. */
  onRenameRequest?: (taskId: string) => void;
  /** Right-click handler (Orca polish item 6); receives client coordinates for the context menu. */
  onContextMenu?: (taskId: string, x: number, y: number) => void;
  /** Lets the owning Sidebar track this row's DOM node for scroll-into-view/reveal (item 1). */
  rowRef?: (taskId: string, node: HTMLDivElement | null) => void;
  /** Brief highlight after a reveal/scroll-to-current (item 1); self-clears in the parent. */
  /** Rendered indented under its parent's row (see lib/task-lineage.ts); purely visual. */
  nested?: boolean;
  /** A child elsewhere whose parent still exists: the "\u21b3 parent title" lineage line. */
  parentTitle?: string;
  /** A standalone launch's display-only provenance line (lib/task-status-lines.ts). */
  provenanceTitle?: string;
  /** Set only on a row that has at least one child (lib/task-lineage.ts); the "N children" chip. */
  childrenInfo?: { count: number; collapsed: boolean; nestedHere: boolean };
  onToggleChildren?: () => void;
  /** Sortable wiring (Sidebar's `SortableTaskRow`); absent for plain/overlay rows. */
  drag?: RowDragProps;
  /** Rendered inside the portaled DragOverlay: no testid collision with the in-flow row, no ref. */
  overlay?: boolean;
}): JSX.Element {
  const { task, state, presence } = row;
  const time = relativeTime(activityTimestamp(row), now);
  // Task messaging chips; "waiting on parent" (while its deadline has not
  // passed on this clock) replaces the amber "your move" with a neutral state.
  const messaging = deriveMessagingChips(
    useMessagingStates().get(task.id),
    now,
  );
  const waiting = messaging.waitingOnParent !== undefined;
  const presenceActivity = derivePresenceActivity(presence, waiting);
  const activity =
    presenceActivity === "working"
      ? "working…"
      : presenceActivity === "your-move"
        ? "your move"
        : presenceActivity === "error"
          ? `error${presence?.status?.message ? `: ${presence.status.message}` : ""}`
          : presenceActivity;
  const attention = presenceActivity === "your-move";
  const outcome = deriveOutcomeLine(presence);
  const launchMarker = deriveLaunchMarker(task);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      setDraftTitle(task.title);
      // Autofocus + select-all so typing immediately replaces the title.
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [isRenaming, task.title]);

  const commitRename = (): void => {
    const next = draftTitle.trim();
    onRenameCommit?.(task.id, next.length > 0 ? next : task.title);
  };

  const onTitleDoubleClick = (event: MouseEvent<HTMLSpanElement>): void => {
    event.stopPropagation();
    onRenameRequest?.(task.id);
  };

  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onRenameCancel?.();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isRenaming) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(task.id);
    }
  };

  const onRowContextMenu = (event: MouseEvent<HTMLDivElement>): void => {
    if (!onContextMenu) return;
    event.preventDefault();
    onContextMenu(task.id, event.clientX, event.clientY);
  };

  const onCloseClick = (event: MouseEvent<HTMLButtonElement>): void => {
    // The close button sits inside the row's own click target; never let it
    // also focus/attach the task.
    event.stopPropagation();
    onClose(task.id);
  };

  // Middle-click closes the row from anywhere on it, on mouse DOWN like
  // cmux's SidebarPointerInteractionMonitor (an .otherMouseDown monitor with
  // buttonNumber == 2). preventDefault also suppresses the browser's
  // middle-click autoscroll.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button === 1) {
      event.preventDefault();
      onClose(task.id);
      return;
    }
    // dnd-kit's PointerSensor activator ignores non-primary buttons, so a
    // right-click (context menu) or middle-click never starts a drag.
    const start = drag?.listeners?.onPointerDown;
    if (typeof start === "function") start(event);
  };
  const { onPointerDown: _ownPointerDown, ...otherListeners } =
    drag?.listeners ?? {};

  return (
    <div
      ref={drag?.setNodeRef}
      style={drag?.style}
      className={cn(
        "border-b border-border/40 px-1.5 py-1 last:border-b-0",
        // Attached under its parent's row (see lib/task-lineage.ts).
        nested && "ml-3 border-l-2 border-l-primary/30 pl-1",
        overlay && "rounded-lg border border-primary bg-card",
        drag?.isDragging && "opacity-40",
      )}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: nested interactive PR chip rules out a native <button> row */}
      <div
        {...drag?.attributes}
        {...otherListeners}
        ref={(node) => {
          if (!overlay) rowRef?.(task.id, node);
        }}
        role="button"
        tabIndex={0}
        data-testid={
          overlay ? "sidebar-drag-overlay-row" : `sidebar-task-row-${task.id}`
        }
        data-task-id={task.id}
        data-selected={selected || undefined}
        data-pinned={pinned || undefined}
        data-unread={unread || undefined}
        aria-pressed={selected}
        onClick={() => !isRenaming && onSelect(task.id)}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onContextMenu={onRowContextMenu}
        className={cn(
          "group relative flex cursor-pointer flex-col gap-1 rounded-md px-2.5 py-2 text-left outline-none transition-colors duration-[120ms] ease-out",
          "hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring",
          // Selected: accent fill + the 2px mint left edge.
          selected &&
            "bg-accent hover:bg-accent before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusDot presence={presence} waitingOnParent={waiting} />
          {pinned && (
            <Pin
              className="h-3 w-3 shrink-0 rotate-45 text-muted-foreground"
              aria-hidden
              data-testid="sidebar-row-pin-icon"
            />
          )}
          {unread && (
            <span
              data-testid="sidebar-row-unread-dot"
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground"
            />
          )}
          {isRenaming ? (
            <input
              ref={inputRef}
              type="text"
              value={draftTitle}
              data-testid={`sidebar-row-rename-input-${task.id}`}
              onChange={(event) => setDraftTitle(event.target.value)}
              onKeyDown={onRenameKeyDown}
              onClick={(event) => event.stopPropagation()}
              onBlur={commitRename}
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-primary bg-card px-1 py-0.5 text-sm font-semibold text-foreground outline-none ring-1 ring-ring"
            />
          ) : (
            // biome-ignore lint/a11y/noStaticElementInteractions: double-click-to-rename is a bonus affordance alongside the context menu's Rename item and the row's own keyboard/click handling; no new interaction surface for keyboard users.
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm text-foreground",
                unread ? "font-semibold" : "font-medium",
              )}
              title={task.title}
              data-testid="sidebar-row-title"
              onDoubleClick={onTitleDoubleClick}
            >
              {task.title}
            </span>
          )}
          {time && !isRenaming && (
            <span
              className="shrink-0 text-[11px] tabular-nums text-muted-foreground group-hover:hidden"
              data-testid="sidebar-row-time"
              title={activityTimestamp(row)}
            >
              {time}
            </span>
          )}
          <button
            type="button"
            data-testid="sidebar-row-close"
            aria-label={`Close ${task.title}`}
            title="Close workspace"
            onClick={onCloseClick}
            onPointerDown={stopPointerDown}
            onKeyDown={(event) => event.stopPropagation()}
            className="hidden shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground group-hover:flex"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 pl-5">
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
            title={task.branch}
            data-testid="sidebar-row-branch"
          >
            {task.branch ?? ""}
          </span>
          <span
            data-testid="state-chip"
            data-state={state}
            className={cn(CHIP_BASE, STATE_CHIP_CLASS[state])}
          >
            {stateChipLabel(task, state)}
          </span>
          <PrChip task={task} />
          {waiting && (
            <span
              data-testid="sidebar-row-waiting-on-parent"
              title="Asked its parent a question; waiting for the answer"
              className={cn(CHIP_BASE, NEUTRAL_CHIP)}
            >
              waiting on parent
            </span>
          )}
          {messaging.approvalsWaiting > 0 && (
            <span
              data-testid="sidebar-row-approval-waiting"
              title="A message to this task is waiting for your approval"
              className={cn(CHIP_BASE, NEEDS_YOU_CHIP)}
            >
              message awaiting approval
            </span>
          )}
          {messaging.childQuestionsWaiting > 0 && (
            <span
              data-testid="sidebar-row-child-question"
              title="A child task asked this task a question"
              className={cn(CHIP_BASE, NEEDS_YOU_CHIP)}
            >
              child asked a question
            </span>
          )}
          {messaging.loopCapReached && (
            <span
              data-testid="sidebar-row-loop-cap"
              title={loopCapLabel(messaging.loopCapReached)}
              className={cn(CHIP_BASE, NEEDS_YOU_CHIP)}
            >
              message cap reached
            </span>
          )}
          {launchMarker === "queued" && (
            <span
              data-testid="sidebar-row-launch-queued"
              className={cn(CHIP_BASE, NEUTRAL_CHIP)}
            >
              queued
            </span>
          )}
          {launchMarker === "interrupted" && (
            <span
              data-testid="sidebar-row-launch-interrupted"
              className={cn(CHIP_BASE, ERROR_CHIP)}
            >
              interrupted
            </span>
          )}
        </div>
        {activity && (
          <div
            className="flex min-w-0 items-center gap-1 pl-5 text-[11px] text-muted-foreground/80"
            data-testid="sidebar-row-activity"
          >
            <span
              className="shrink-0 font-medium text-muted-foreground"
              data-testid="sidebar-row-agent"
              title={task.thinking ? `Thinking: ${task.thinking}` : undefined}
            >
              {taskAgentLabel(task)}
            </span>
            <span aria-hidden>·</span>
            <span
              className={cn(
                "truncate",
                attention && "font-medium text-status-ok",
                presenceActivity === "error" && "text-status-error",
              )}
              data-testid="sidebar-row-activity-text"
            >
              {activity}
            </span>
          </div>
        )}
        {messaging.waitingOnParent && (
          <p
            className="truncate pl-5 text-[11px] text-muted-foreground"
            data-testid="sidebar-row-waiting-question"
            title={messaging.waitingOnParent.question}
          >
            {messaging.waitingOnParent.question}
          </p>
        )}
        {parentTitle && (
          <p
            className="truncate pl-5 text-[11px] text-muted-foreground"
            data-testid="sidebar-row-lineage-line"
            title={`Child of "${parentTitle}"`}
          >
            ↳ {parentTitle}
          </p>
        )}
        {provenanceTitle && (
          <p
            className="truncate pl-5 text-[11px] text-muted-foreground"
            data-testid="sidebar-row-provenance-line"
          >
            {provenanceTitle}
          </p>
        )}
        {outcome && (
          <p
            className={cn(
              "truncate pl-5 text-[11px]",
              outcome.status === "blocked"
                ? "text-status-needsYou"
                : "text-muted-foreground",
            )}
            data-testid="sidebar-row-outcome-line"
            title={outcome.note}
          >
            {outcome.note}
          </p>
        )}
        {childrenInfo && (
          <button
            type="button"
            data-testid={`sidebar-row-lineage-toggle-${task.id}`}
            disabled={!childrenInfo.nestedHere}
            aria-expanded={
              childrenInfo.nestedHere ? !childrenInfo.collapsed : undefined
            }
            onPointerDown={stopPointerDown}
            onClick={(event) => {
              event.stopPropagation();
              onToggleChildren?.();
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className={cn(
              "ml-5 flex items-center gap-1 self-start text-[11px] text-muted-foreground",
              childrenInfo.nestedHere
                ? "hover:text-foreground"
                : "cursor-default opacity-70",
            )}
          >
            {childrenInfo.nestedHere &&
              (childrenInfo.collapsed ? (
                <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
              ) : (
                <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
              ))}
            {childrenInfo.count}{" "}
            {childrenInfo.count === 1 ? "child" : "children"}
          </button>
        )}
      </div>
    </div>
  );
}
