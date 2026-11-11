import { ChevronDown, ChevronRight, Pin, X } from "lucide-react";
import type {
  CSSProperties,
  HTMLAttributes,
  JSX,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
} from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Task } from "../../../preload/api";
import { useMessagingStates } from "../core-client";
import { createSharedStore } from "../lib/shared-store";
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

/** Bordered chip tones, matching the board's per-column colors. */
const STATE_CHIP_CLASS: Record<StateTone, string> = {
  backlog: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
  dev: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  awaiting: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
};

const PR_CHIP_CLASS: Record<ReturnType<typeof prBadgeVariant>, string> = {
  success: "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/15",
  draft: "border-slate-500/40 text-slate-300 hover:bg-slate-500/15",
  merged: "border-violet-500/40 text-violet-300 hover:bg-violet-500/15",
  closed: "border-red-500/40 text-red-300 hover:bg-red-500/15",
  changes: "border-amber-500/40 text-amber-300 hover:bg-amber-500/15",
};

const CHIP_BASE =
  "inline-flex h-[18px] shrink-0 items-center rounded border px-1.5 text-[10px] font-medium leading-none";

/** Half-period of the running dot's halo blink. */
const RUNNING_BLINK_MS = 1_000;

/**
 * One shared, low-frequency blink for every running-turn dot. Deliberately
 * not a CSS `animate-ping`/`animate-pulse`: an infinite CSS animation makes
 * Chromium produce a frame every vsync (recompositing the window, terminal
 * panes included) for as long as any agent runs. A 1s toggle costs one tiny repaint
 * per second instead, and the timer only runs while a running dot is
 * mounted (ref-counted, see lib/shared-store.ts).
 */
const runningBlink = createSharedStore<boolean>(false, (set) => {
  let on = false;
  set(on);
  const timer = setInterval(() => {
    on = !on;
    set(on);
  }, RUNNING_BLINK_MS);
  return () => clearInterval(timer);
});

function RunningDot(): JSX.Element {
  const haloOn = useSyncExternalStore(
    runningBlink.subscribe,
    runningBlink.getSnapshot,
  );
  return (
    <span
      className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center"
      data-testid="sidebar-row-spinner"
      data-status="running"
      role="img"
      aria-label="Agent working"
    >
      {/* Halo blinks (no transition); reduced-motion users get it steady. */}
      <span
        className={cn(
          "absolute inline-flex h-full w-full rounded-full ring-2 ring-sky-400/50 motion-reduce:opacity-100",
          haloOn ? "opacity-100" : "opacity-0",
        )}
      />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-400" />
    </span>
  );
}

/**
 * Live-presence indicator. Keeps the pre-redesign test ids so e2e coverage
 * carries over: `sidebar-row-spinner` while an agent turn runs (pulsing
 * halo — the "moving symbol while it works", a cheap 1s blink), `sidebar-row-attention-dot`
 * for live-but-idle — pi-home's ● "your move": the agent finished its loop
 * and waits on you, so it is styled as attention (amber), not as a calm
 * "all good" — and `sidebar-row-status-dot` otherwise (muted gray).
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
        <span className="h-2 w-2 rounded-full bg-red-400" />
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
        <span className="h-2 w-2 rounded-full bg-emerald-400/70" />
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
        <span className="h-2 w-2 rounded-full bg-zinc-400" />
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
        <span className="h-2 w-2 rounded-full bg-amber-400 ring-2 ring-amber-400/30" />
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
      <span className="h-2 w-2 rounded-full bg-zinc-600" />
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

  // Middle-click (auxclick, button 1) closes the row from anywhere on it,
  // matching cmux's SidebarPointerInteractionMonitor.
  const onAuxClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 1) return;
    event.preventDefault();
    onClose(task.id);
  };

  // Suppress the browser's default middle-click autoscroll so the auxclick
  // above isn't fighting a scroll gesture.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button === 1) event.preventDefault();
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
        overlay && "rounded-md border bg-background shadow-lg",
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
        onAuxClick={onAuxClick}
        onPointerDown={onPointerDown}
        onContextMenu={onRowContextMenu}
        className={cn(
          "group flex cursor-pointer flex-col gap-1 rounded-md px-2.5 py-2 text-left outline-none transition-colors",
          "hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-primary/60",
          selected && "bg-accent/70 hover:bg-accent/70",
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
              className="min-w-0 flex-1 rounded border border-primary/60 bg-background px-1 py-0.5 text-sm font-semibold text-foreground outline-none"
            />
          ) : (
            // biome-ignore lint/a11y/noStaticElementInteractions: double-click-to-rename is a bonus affordance alongside the context menu's Rename item and the row's own keyboard/click handling; no new interaction surface for keyboard users.
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm text-foreground",
                unread ? "font-bold" : "font-semibold",
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
            className="hidden shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground group-hover:flex"
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
              className={cn(
                CHIP_BASE,
                "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
              )}
            >
              waiting on parent
            </span>
          )}
          {messaging.approvalsWaiting > 0 && (
            <span
              data-testid="sidebar-row-approval-waiting"
              title="A message to this task is waiting for your approval"
              className={cn(
                CHIP_BASE,
                "border-sky-500/40 bg-sky-500/10 text-sky-300",
              )}
            >
              message awaiting approval
            </span>
          )}
          {messaging.childQuestionsWaiting > 0 && (
            <span
              data-testid="sidebar-row-child-question"
              title="A child task asked this task a question"
              className={cn(
                CHIP_BASE,
                "border-sky-500/40 bg-sky-500/10 text-sky-300",
              )}
            >
              child asked a question
            </span>
          )}
          {messaging.loopCapReached && (
            <span
              data-testid="sidebar-row-loop-cap"
              title={loopCapLabel(messaging.loopCapReached)}
              className={cn(
                CHIP_BASE,
                "border-amber-500/40 bg-amber-500/10 text-amber-300",
              )}
            >
              message cap reached
            </span>
          )}
          {launchMarker === "queued" && (
            <span
              data-testid="sidebar-row-launch-queued"
              className={cn(
                CHIP_BASE,
                "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
              )}
            >
              queued
            </span>
          )}
          {launchMarker === "interrupted" && (
            <span
              data-testid="sidebar-row-launch-interrupted"
              className={cn(
                CHIP_BASE,
                "border-amber-500/40 bg-amber-500/10 text-amber-300",
              )}
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
                attention && "font-medium text-amber-300",
                presenceActivity === "error" && "text-red-300",
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
                ? "text-amber-300"
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
