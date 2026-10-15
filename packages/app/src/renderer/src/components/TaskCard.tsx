import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Loader2 } from "lucide-react";
import type { JSX } from "react";
import type { Task } from "../../../preload/api";
import { cn } from "../lib/utils";
import { prBadgeLabel, prBadgeVariant } from "./pr-badge";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

/**
 * One board card: title, branch, PR/presence/unread chrome only. Cards
 * carry no action buttons — the workflow verbs live in the workspace
 * header, the board's keys (s/r/x, see BoardKeyLegend), and drag-and-drop.
 */
export function TaskCard({
  task,
  presence,
  onSelect,
  selected,
  unread,
}: {
  task: Task;
  /** Live/runningTurn snapshot from the ~5s presence poll; absent task ids are treated as not-present. */
  presence?: { live: boolean; runningTurn: boolean } | undefined;
  onSelect?: (taskId: string) => void;
  /** Keyboard-selected card (see Board.tsx); draws a visible ring, independent of mouse hover/click. */
  selected?: boolean;
  /** "Finished while you weren't looking" (Orca polish item 7, see core-client.ts's useUnreadTaskIds); a subtle card badge, cleared once the task gains focus. */
  unread?: boolean | undefined;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: task.id,
    });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  const running = !!presence?.runningTurn;
  // Live but idle = pi-home's ● "your move": the agent is waiting on you.
  const attention = !!presence?.live && !running;

  return (
    <Card
      ref={setNodeRef}
      style={style}
      data-testid={`card-${task.id}`}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "cursor-grab touch-none select-none active:cursor-grabbing",
        isDragging && "opacity-50 ring-1 ring-primary",
        selected && "ring-2 ring-primary ring-offset-1 ring-offset-background",
      )}
      onClick={() => onSelect?.(task.id)}
      {...attributes}
      {...listeners}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          {unread && (
            <span
              data-testid="badge-unread"
              title="Finished while you weren't looking"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400"
              aria-hidden
            />
          )}
          {task.title}
        </CardTitle>
        {task.branch && (
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{task.branch}</span>
            {task.targetBranch && (
              <>
                {" → "}
                <span className="font-mono">{task.targetBranch}</span>
              </>
            )}
          </p>
        )}
      </CardHeader>
      <CardContent className="flex-row flex-wrap items-center gap-1.5">
        {running && (
          <Badge
            variant="secondary"
            className="gap-1"
            data-testid="badge-running"
          >
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            running
          </Badge>
        )}
        {attention && (
          <Badge
            variant="outline"
            className="gap-1 border-amber-400/60 text-amber-300"
            data-testid="badge-attention"
          >
            <span
              className="h-1.5 w-1.5 rounded-full bg-amber-400"
              aria-hidden
            />
            your move
          </Badge>
        )}
        {task.pr && (
          <Badge variant={prBadgeVariant(task.pr)} data-testid="badge-pr">
            {prBadgeLabel(task.pr)}
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
