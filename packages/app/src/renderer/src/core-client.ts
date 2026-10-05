// Renderer data layer over the narrow `window.harbormaster.core` IPC bridge
// (see /src/preload/api.ts and /src/main/index.ts). Replaces the old
// mock.ts: the board is now fetched from @harbormaster/core on mount and
// kept live via the "board-changed" push channel — no frontend reads or
// writes state files directly (see /docs/design-decisions.md "Core is
// headless").
import { useEffect, useState } from "react";
import type { BoardColumn, Task, TaskState } from "../../preload/api";

export type { BoardColumn, Task, TaskState } from "../../preload/api";

/** One flattened sidebar row: a task plus the column it currently sits in. */
export interface FlatTaskRow {
  task: Task;
  state: TaskState;
}

/** Column order is already backlog/dev/awaiting/done per the core's TASK_STATES. */
export function flattenBoard(columns: BoardColumn[]): FlatTaskRow[] {
  return columns.flatMap((column) =>
    column.groups.flatMap((group) =>
      group.tasks.map((task) => ({ task, state: column.state })),
    ),
  );
}

/**
 * Subscribes to the live board: fetches once on mount, then replaces state
 * wholesale on every "board-changed" push (the core always sends the full
 * column list, so there is nothing to merge).
 */
export function useBoard(): BoardColumn[] {
  const [columns, setColumns] = useState<BoardColumn[]>([]);

  useEffect(() => {
    let cancelled = false;
    void window.harbormaster.core.listBoard().then((cols) => {
      if (!cancelled) setColumns(cols);
    });
    const unsubscribe = window.harbormaster.core.onBoardChanged((payload) => {
      if (!cancelled) setColumns(payload.columns);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return columns;
}
