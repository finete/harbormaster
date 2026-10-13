import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Loader2 } from "lucide-react";
import type { JSX } from "react";
import type { Task } from "../../../preload/api";
import { cn } from "../lib/utils";
import { prBadgeLabel, prBadgeVariant } from "./pr-badge";
import { TaskActions } from "./TaskActions";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export function TaskCard({
  task,
  presence,
  onSelect,
  selected,
}: {
  task: Task;
  /** Live/runningTurn snapshot from the ~5s presence poll; absent task ids are treated as not-present. */
  presence?: { live: boolean; runningTurn: boolean } | undefined;
  onSelect?: (taskId: string) => void;
  /** Keyboard-selected card (see Board.tsx); draws a visible ring, independent of mouse hover/click. */
  selected?: boolean;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: task.id,
    });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  const running = !!presence?.runningTurn;
  const attached = !!presence?.live && !running;

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
        <CardTitle>{task.title}</CardTitle>
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
        {attached && (
          <Badge
            variant="outline"
            className="gap-1 opacity-75"
            data-testid="badge-attached"
          >
            attached
          </Badge>
        )}
        {task.pr && (
          <Badge variant={prBadgeVariant(task.pr)} data-testid="badge-pr">
            {prBadgeLabel(task.pr)}
          </Badge>
        )}
      </CardContent>
      <div className="px-3 pb-2">
        <TaskActions
          task={task}
          onPointerDownCapture={(event) => event.stopPropagation()}
        />
      </div>
    </Card>
  );
}
