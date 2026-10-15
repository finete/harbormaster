import { Pin, X } from "lucide-react";
import type { JSX, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { Task } from "../../../preload/api";
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
};

const CHIP_BASE =
  "inline-flex h-[18px] shrink-0 items-center rounded border px-1.5 text-[10px] font-medium leading-none";

/**
 * Live-presence indicator. Keeps the pre-redesign test ids so e2e coverage
 * carries over: `sidebar-row-spinner` while an agent turn runs (pulsing
 * halo — the "moving symbol while it works"), `sidebar-row-attention-dot`
 * for live-but-idle — pi-home's ● "your move": the agent finished its loop
 * and waits on you, so it is styled as attention (amber), not as a calm
 * "all good" — and `sidebar-row-status-dot` otherwise (muted gray).
 */
export function StatusDot({
  presence,
}: {
  presence: SidebarRow["presence"];
}): JSX.Element {
  if (presence?.runningTurn) {
    return (
      <span
        className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center"
        data-testid="sidebar-row-spinner"
        data-status="running"
        role="img"
        aria-label="Agent working"
      >
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400/60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-400" />
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
      onClick={open}
      onKeyDown={(event) => event.stopPropagation()}
      disabled={!url}
      title={`${prBadgeLabel(pr)}${url ? " — open on GitHub" : ""}`}
      className={cn(
        CHIP_BASE,
        "cursor-pointer font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-default",
        PR_CHIP_CLASS[prBadgeVariant(pr)],
      )}
    >
      #{pr.number}
    </button>
  );
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
}): JSX.Element {
  const { task, state, presence } = row;
  const time = relativeTime(activityTimestamp(row), now);
  const activity = presence?.runningTurn
    ? "working…"
    : presence?.live
      ? "your move"
      : undefined;
  const attention = !presence?.runningTurn && !!presence?.live;
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
  };

  return (
    <div className="border-b border-border/40 px-1.5 py-1 last:border-b-0">
      {/* biome-ignore lint/a11y/useSemanticElements: nested interactive PR chip rules out a native <button> row */}
      <div
        ref={(node) => rowRef?.(task.id, node)}
        role="button"
        tabIndex={0}
        data-testid={`sidebar-task-row-${task.id}`}
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
          <StatusDot presence={presence} />
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
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400"
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
        </div>
        {activity && (
          <div
            className="flex min-w-0 items-center gap-1 pl-5 text-[11px] text-muted-foreground/80"
            data-testid="sidebar-row-activity"
          >
            <span className="font-medium text-muted-foreground">pi</span>
            <span aria-hidden>·</span>
            <span
              className={cn(
                "truncate",
                attention && "font-medium text-amber-300",
              )}
            >
              {activity}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
