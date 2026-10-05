import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { JSX } from "react";
import { useState } from "react";
import { type ColumnId, mockCards, mockColumns } from "../mock";
import { BoardColumn } from "./BoardColumn";

/**
 * Mock kanban board — local-state only. Columns and card placement are a
 * stand-in for @harbormaster/core's board state; see src/renderer/src/mock.ts.
 * This is the "home" triage screen: clicking a card hands off to the
 * workspace view, focused on that task.
 */
export function Board({
  onSelectTask,
}: {
  onSelectTask: (taskId: string) => void;
}): JSX.Element {
  const [columns, setColumns] = useState(() =>
    mockColumns.map((column) => ({ ...column, cardIds: [...column.cardIds] })),
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over) return;

    const targetColumnId = over.id as ColumnId;
    const cardId = active.id as string;

    setColumns((prev) => {
      const sourceIndex = prev.findIndex((c) => c.cardIds.includes(cardId));
      const targetIndex = prev.findIndex((c) => c.id === targetColumnId);
      if (sourceIndex === -1 || targetIndex === -1) return prev;
      if (prev[sourceIndex]?.id === targetColumnId) return prev;

      const next = prev.map((c) => ({ ...c, cardIds: [...c.cardIds] }));
      const source = next[sourceIndex];
      const target = next[targetIndex];
      if (!source || !target) return prev;
      source.cardIds = source.cardIds.filter((id) => id !== cardId);
      target.cardIds = [...target.cardIds, cardId];
      return next;
    });
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex h-full gap-3 overflow-x-auto p-3">
        {columns.map((column) => (
          <BoardColumn
            key={column.id}
            column={column}
            cards={column.cardIds
              .map((id) => mockCards[id])
              .filter((c): c is NonNullable<typeof c> => Boolean(c))}
            onSelectTask={onSelectTask}
          />
        ))}
      </div>
    </DndContext>
  );
}
