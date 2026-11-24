// "Show on board" from the import summary (docs/import.md I10): the board
// opens and the imported cards are highlighted for a few seconds. A tiny
// module-level store so the inbox (which resolves the button) and the cards
// (which draw the highlight) need no shared parent state.

import { useSyncExternalStore } from "react";

/** How long the highlight stays. */
export const HIGHLIGHT_MS = 5_000;

const EMPTY: ReadonlySet<string> = new Set();
let current: ReadonlySet<string> = EMPTY;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function publish(next: ReadonlySet<string>): void {
  current = next;
  for (const listener of listeners) listener();
}

/** Highlight these tasks' cards, replacing any earlier highlight. */
export function highlightTasks(
  taskIds: readonly string[],
  ms: number = HIGHLIGHT_MS,
): void {
  if (timer) clearTimeout(timer);
  publish(new Set(taskIds));
  timer = setTimeout(() => {
    timer = undefined;
    publish(EMPTY);
  }, ms);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether `taskId`'s card is highlighted right now. */
export function useTaskHighlighted(taskId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => current.has(taskId),
    () => false,
  );
}
