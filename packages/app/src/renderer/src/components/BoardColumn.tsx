import { useDroppable } from "@dnd-kit/core";
import type { JSX } from "react";
import { cn } from "../lib/utils";
import type { MockColumn, TaskCard as TaskCardData } from "../mock";
import { TaskCard } from "./TaskCard";

export function BoardColumn({
  column,
  cards,
}: {
  column: MockColumn;
  cards: TaskCardData[];
}): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div
      ref={setNodeRef}
      data-testid={`column-${column.id}`}
      className={cn(
        "flex min-w-[240px] flex-1 flex-col gap-2 rounded-lg border border-border bg-muted/30 p-2",
        isOver && "ring-1 ring-primary",
      )}
    >
      <div className="flex items-center justify-between px-1 pb-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {column.title}
        </h2>
        <span className="text-xs text-muted-foreground">{cards.length}</span>
      </div>
      <div
        className="flex min-h-[40px] flex-col gap-2"
        data-testid={`column-${column.id}-cards`}
      >
        {cards.map((card) => (
          <TaskCard key={card.id} card={card} />
        ))}
      </div>
    </div>
  );
}
