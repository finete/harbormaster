// App-owned sidebar order state (ai/prds/sidebar-ordering.md): the global
// task order (R2) and the detached-children set (R12), persisted to
// localStorage. Owned by App.tsx — not Sidebar — because the order is
// maintained from App's single open path (`openTask`, R3) and single close
// path (`closeTask`, R4), while Sidebar reads it and rewrites it on drop.
// Reading happens synchronously at mount (no async restore involved), and
// nothing here prunes the order against `openedTaskIds`, so the async
// workspace restore can never wipe a stored order.
import { useCallback, useEffect, useState } from "react";
import { appendToOrder, removeFromOrder } from "./sidebar-order";
import {
  readDetachedChildIds,
  readTaskOrder,
  storeDetachedChildIds,
  storeTaskOrder,
} from "./sidebar-persistence";

export interface SidebarOrderState {
  taskOrder: readonly string[];
  detachedIds: ReadonlySet<string>;
  setTaskOrder: (order: readonly string[]) => void;
  setDetachedIds: (ids: ReadonlySet<string>) => void;
  /** Open path: a task not yet in the order lands at the bottom. */
  appendOpened: (taskId: string) => void;
  /** Close path: forget the task's position and detached flag, so a reopen lands at the bottom. */
  removeClosed: (taskId: string) => void;
}

export function useSidebarOrder(): SidebarOrderState {
  const [taskOrder, setTaskOrder] = useState<readonly string[]>(() =>
    readTaskOrder(window.localStorage),
  );
  const [detachedIds, setDetachedIds] = useState<ReadonlySet<string>>(() =>
    readDetachedChildIds(window.localStorage),
  );
  useEffect(() => {
    storeTaskOrder(window.localStorage, taskOrder);
  }, [taskOrder]);
  useEffect(() => {
    storeDetachedChildIds(window.localStorage, detachedIds);
  }, [detachedIds]);

  const appendOpened = useCallback((taskId: string): void => {
    setTaskOrder((prev) => appendToOrder(prev, taskId));
  }, []);
  const removeClosed = useCallback((taskId: string): void => {
    setTaskOrder((prev) => removeFromOrder(prev, taskId));
    setDetachedIds((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
  }, []);
  return {
    taskOrder,
    detachedIds,
    setTaskOrder,
    setDetachedIds,
    appendOpened,
    removeClosed,
  };
}
