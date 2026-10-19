import { useDraggable } from "@dnd-kit/core";
import { Loader2 } from "lucide-react";
import type { HTMLAttributes, JSX } from "react";
import type { PresenceBadge, Task } from "../../../preload/api";
import {
  deriveLaunchMarker,
  deriveOutcomeLine,
} from "../lib/task-status-lines";
import {
  lastInteractionTimestamp,
  relativeTime,
  waitingDurationText,
} from "../lib/time-format";
import { useNow } from "../lib/use-now";
import { cn } from "../lib/utils";
import { prBadgeLabel, prBadgeVariant } from "./pr-badge";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";

type TaskCardPresence = PresenceBadge | undefined;

/**
 * One board card: title, branch, PR/presence/unread chrome only, plus a
 * muted relative-time indicator (top-right of the title row) and, for
 * Awaiting cards, a "waiting <duration>" fragment in the sub-line — ported
 * from pi-home's card anatomy (`withLastInteraction` +
 * `awaitingSourceText`, src/presentation/home-controller.ts and
 * home-board.ts). Cards carry no action buttons — the workflow verbs live
 * in the workspace header, the board's keys (s/r/x, see BoardKeyLegend),
 * and drag-and-drop.
 *
 * `overlay` renders the same card as a presentation-only lookalike for
 * Board.tsx's portaled `<DragOverlay>` (dnd-kit's canonical drag preview):
 * no `useDraggable` registration (a second draggable under the same id would
 * clobber the real card's node), no click handler, no `card-<id>` testid.
 * The real card never moves while dragging — it just dims in place — so
 * nothing inside a column's overflow scroller is ever transformed (which is
 * what clipped the preview at column edges and flashed a phantom horizontal
 * scrollbar).
 */
export function TaskCard({
  overlay = false,
  ...props
}: TaskCardProps & {
  /** Presentation-only drag-preview copy (see above); never draggable or clickable. */
  overlay?: boolean;
}): JSX.Element {
  if (overlay) return <TaskCardFace {...props} variant="overlay" />;
  return <DraggableTaskCard {...props} />;
}

interface TaskCardProps {
  task: Task;
  /** Live/runningTurn/heartbeat snapshot from the ~5s presence poll; absent task ids are treated as not-present. */
  presence?: TaskCardPresence;
  onSelect?: (taskId: string) => void;
  /** Keyboard-selected card (see Board.tsx); draws a visible ring, independent of mouse hover/click. */
  selected?: boolean;
  /** "Finished while you weren't looking" (Orca polish item 7, see core-client.ts's useUnreadTaskIds); a subtle card badge, cleared once the task gains focus. */
  unread?: boolean | undefined;
  /** Rendered indented/attached under its parent's card (see lib/task-lineage.ts); purely visual. */
  nested?: boolean;
  /** A child elsewhere (different column/group) whose parent still exists: the "\u21b3 parent title" lineage line (lib/task-lineage.ts). */
  parentTitle?: string;
  /** A standalone launch's display-only provenance line (lib/task-status-lines.ts). */
  provenanceTitle?: string;
}

function DraggableTaskCard(props: TaskCardProps): JSX.Element {
  // No `transform` is applied: the portaled DragOverlay is what follows the
  // pointer; this in-flow card stays put as a dimmed placeholder.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: props.task.id,
  });
  return (
    <TaskCardFace
      {...props}
      variant={isDragging ? "placeholder" : "card"}
      cardRef={setNodeRef}
      dragProps={{ ...attributes, ...listeners }}
    />
  );
}

function TaskCardFace({
  task,
  presence,
  onSelect,
  selected,
  unread,
  nested,
  parentTitle,
  provenanceTitle,
  variant,
  cardRef,
  dragProps,
}: TaskCardProps & {
  variant: "card" | "placeholder" | "overlay";
  cardRef?: (element: HTMLElement | null) => void;
  dragProps?: HTMLAttributes<HTMLDivElement>;
}): JSX.Element {
  const running = !!presence?.runningTurn;
  // Live but idle = pi-home's ● "your move": the agent is waiting on you.
  const attention = !!presence?.live && !running;
  const outcome = deriveOutcomeLine(presence);
  const launchMarker = deriveLaunchMarker(task);

  // Same 30s tick the sidebar rail uses (lib/use-now.ts), so the card's
  // relative time and waiting-duration stay fresh without a prop from Board.
  const now = useNow();
  const isAwaiting = task.state === "awaiting" && !!task.awaiting;
  const isOverlay = variant === "overlay";

  return (
    <Card
      ref={cardRef}
      {...(isOverlay
        ? { "data-testid": "drag-overlay-card", "data-task-id": task.id }
        : {
            "data-testid": `card-${task.id}`,
            "data-selected": selected ? "true" : "false",
            onClick: () => onSelect?.(task.id),
          })}
      className={cn(
        // One fixed slot skeleton for every variant (item 18): top-pinned
        // column, slots in order title-row / mono-subline / badge-row, each
        // absent slot rendering nothing (no empty padded wrapper), so a
        // title-only card is simply shorter, never differently aligned.
        "flex select-none flex-col gap-1 p-3",
        isOverlay
          ? // "Lifted" pick-up (Trello/Linear convention), overlay only.
            "scale-[1.02] cursor-grabbing shadow-xl ring-1 ring-primary"
          : "cursor-grab touch-none transition-colors hover:border-primary/40 hover:bg-accent/40 active:cursor-grabbing",
        variant === "placeholder" && "opacity-40",
        !isOverlay &&
          selected &&
          "ring-2 ring-primary ring-offset-1 ring-offset-background",
        // Attached under its parent's card (see lib/task-lineage.ts): a
        // visible left rail + indent, pi-home-style tree attachment.
        nested && "ml-4 border-l-2 border-l-primary/30",
      )}
      {...dragProps}
    >
      <div className="flex min-w-0 items-baseline gap-2" data-slot="title-row">
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          {unread && (
            <span
              data-testid="badge-unread"
              title="Finished while you weren't looking"
              className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-foreground"
              aria-hidden
            />
          )}
          <span
            className="min-w-0 truncate text-sm font-semibold leading-tight"
            data-slot="title"
          >
            {task.title}
          </span>
        </span>
        <span
          data-testid="card-time"
          data-slot="time"
          title={lastInteractionTimestamp(task, presence)}
          className="shrink-0 font-mono text-[10px] leading-tight text-muted-foreground"
        >
          {relativeTime(lastInteractionTimestamp(task, presence), now)}
        </span>
      </div>
      {(task.branch || isAwaiting) && (
        <p className="text-xs text-muted-foreground" data-slot="subline">
          {task.branch && <span className="font-mono">{task.branch}</span>}
          {task.branch && task.targetBranch && (
            <>
              {" → "}
              <span className="font-mono">{task.targetBranch}</span>
            </>
          )}
          {isAwaiting && (
            <span data-testid="card-waiting-duration" className="font-mono">
              {task.branch ? " · " : ""}
              {waitingDurationText(task.stateChangedAt, now)}
            </span>
          )}
        </p>
      )}
      {parentTitle && (
        <p
          className="truncate text-xs text-muted-foreground"
          data-slot="lineage"
          data-testid="card-lineage-line"
          title={`Child of "${parentTitle}"`}
        >
          ↳ {parentTitle}
        </p>
      )}
      {provenanceTitle && (
        <p
          className="truncate text-xs text-muted-foreground"
          data-slot="provenance"
          data-testid="card-provenance-line"
        >
          {provenanceTitle}
        </p>
      )}
      {outcome && (
        <p
          className={cn(
            "truncate text-xs",
            outcome.status === "blocked"
              ? "text-amber-300"
              : "text-muted-foreground",
          )}
          data-slot="outcome"
          data-testid="card-outcome-line"
          title={outcome.note}
        >
          {outcome.note}
        </p>
      )}
      {(running || attention || launchMarker || task.pr) && (
        <div
          className="flex flex-wrap items-center gap-1.5 pt-1"
          data-slot="badges"
        >
          {running && (
            <Badge
              variant="secondary"
              className="shrink-0 gap-1"
              data-testid="badge-running"
            >
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              running
            </Badge>
          )}
          {attention && (
            <Badge
              variant="outline"
              className="shrink-0 gap-1 border-amber-400/60 text-amber-300"
              data-testid="badge-attention"
            >
              <span
                className="h-1.5 w-1.5 rounded-full bg-amber-400"
                aria-hidden
              />
              your move
            </Badge>
          )}
          {launchMarker === "queued" && (
            <Badge
              variant="secondary"
              className="shrink-0"
              data-testid="badge-launch-queued"
            >
              queued
            </Badge>
          )}
          {launchMarker === "interrupted" && (
            <Badge
              variant="outline"
              className="shrink-0 gap-1 border-amber-400/60 text-amber-300"
              data-testid="badge-launch-interrupted"
            >
              interrupted
            </Badge>
          )}
          {task.pr && (
            <Badge
              variant={prBadgeVariant(task.pr)}
              className="shrink-0"
              data-testid="badge-pr"
            >
              {prBadgeLabel(task.pr)}
            </Badge>
          )}
        </div>
      )}
    </Card>
  );
}
