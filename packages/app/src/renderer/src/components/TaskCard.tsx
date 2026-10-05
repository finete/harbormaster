import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Loader2 } from "lucide-react";
import type { JSX } from "react";
import type { Task } from "../../../preload/api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

const prVariant = {
  open: "success",
  draft: "draft",
  merged: "merged",
  closed: "closed",
} as const;

export function TaskCard({
  task,
  presence,
  onSelect,
}: {
  task: Task;
  /** Live/runningTurn snapshot from the ~5s presence poll; absent task ids are treated as not-present. */
  presence?: { live: boolean; runningTurn: boolean } | undefined;
  onSelect?: (taskId: string) => void;
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
      className={cn(
        "cursor-grab touch-none select-none active:cursor-grabbing",
        isDragging && "opacity-50 ring-1 ring-primary",
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
          <Badge variant={prVariant[task.pr.state]} data-testid="badge-pr">
            PR #{task.pr.number} · {task.pr.state}
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
