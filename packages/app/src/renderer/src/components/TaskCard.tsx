import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Loader2 } from "lucide-react";
import type { JSX } from "react";
import { cn } from "../lib/utils";
import type { TaskCard as TaskCardData } from "../mock";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

const prVariant = {
  open: "success",
  draft: "draft",
  merged: "merged",
} as const;

export function TaskCard({ card }: { card: TaskCardData }): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: card.id,
    });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  return (
    <Card
      ref={setNodeRef}
      style={style}
      data-testid={`card-${card.id}`}
      className={cn(
        "cursor-grab touch-none select-none active:cursor-grabbing",
        isDragging && "opacity-50 ring-1 ring-primary",
      )}
      {...attributes}
      {...listeners}
    >
      <CardHeader>
        <CardTitle>{card.title}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {card.repo} · <span className="font-mono">{card.branch}</span>
        </p>
      </CardHeader>
      <CardContent className="flex-row flex-wrap items-center gap-1.5">
        {card.running && (
          <Badge
            variant="secondary"
            className="gap-1"
            data-testid="badge-running"
          >
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            running
          </Badge>
        )}
        {card.pr && (
          <Badge variant={prVariant[card.pr.state]} data-testid="badge-pr">
            PR #{card.pr.number} · {card.pr.state}
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
