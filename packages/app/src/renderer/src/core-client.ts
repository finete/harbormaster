// Renderer data layer over the narrow `window.harbormaster.core` IPC bridge
// (see /src/preload/api.ts and /src/main/index.ts). Replaces the old
// mock.ts: the board is now fetched from @harbormaster/core on mount and
// kept live via the "board-changed" push channel — no frontend reads or
// writes state files directly (see /docs/design-decisions.md "Core is
// headless").
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BoardColumn,
  PresenceChangedPayload,
  Task,
  TaskState,
} from "../../preload/api";
import {
  notificationsDisabled,
  notifyTransitionEvents,
} from "./lib/notifications";
import { applyUnreadTransition, clearUnread } from "./lib/unread";

export type {
  BoardColumn,
  PresenceChangedPayload,
  PresenceSnapshot,
  Task,
  TaskState,
} from "../../preload/api";

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

/**
 * Subscribes to the ~5s main-process presence poll (see
 * /src/main/index.ts's `pollPresenceOnce`). Replaces state wholesale on
 * every push "-" the main process always sends the full non-done-task map,
 * so (like `useBoard`) there is nothing to merge.
 */
export function usePresenceMap(): PresenceChangedPayload {
  const [presence, setPresence] = useState<PresenceChangedPayload>({});

  useEffect(() => {
    const unsubscribe = window.harbormaster.core.onPresenceChanged((payload) =>
      setPresence(payload),
    );
    return unsubscribe;
  }, []);

  return presence;
}

/**
 * Manual "refresh now": invokes the same `core:refresh` command main's 30s
 * automation loop runs (PR status + movers + archive sweep; warnings are
 * pushed through the shared refresh-warning channel). `busy` stays set for
 * at least a beat so the spinner is visible even for an instant refresh.
 */
/**
 * Session-local "finished while you weren't looking" tracking (Orca polish
 * item 7): subscribes to the same ~5s presence push `usePresenceMap` does,
 * folding each push through the pure transition rule in `lib/unread.ts`.
 * Self-contained (its own presence subscription) so both the sidebar rows
 * and the board cards can call it without fighting over one shared
 * subscription's state. Never persisted "-" a fresh launch starts clean.
 */
export function useUnreadTaskIds(
  focusedTaskId: string | null,
): ReadonlySet<string> {
  const [unread, setUnread] = useState<Set<string>>(() => new Set());
  const previousRef = useRef<PresenceChangedPayload>({});
  const focusedTaskIdRef = useRef(focusedTaskId);
  focusedTaskIdRef.current = focusedTaskId;
  const windowFocusedRef = useRef(
    typeof document === "undefined" ? true : document.hasFocus(),
  );

  useEffect(() => {
    function onFocus(): void {
      windowFocusedRef.current = true;
      const current = focusedTaskIdRef.current;
      if (current) setUnread((prev) => clearUnread(prev, current));
    }
    function onBlur(): void {
      windowFocusedRef.current = false;
    }
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.harbormaster.core.onPresenceChanged(
      (payload) => {
        // Capture the pre-push snapshot *before* touching the ref: React's
        // `setUnread` updater below can run after this callback returns
        // (it isn't a React-originated event, so updates aren't
        // synchronously flushed), and by then `previousRef.current =
        // payload` would already have overwritten it "-" comparing the new
        // push against itself and never seeing a transition.
        const previous = previousRef.current;
        previousRef.current = payload;
        setUnread((current) =>
          applyUnreadTransition(current, {
            previous,
            next: payload,
            focusedTaskId,
            windowFocused: windowFocusedRef.current,
          }),
        );
      },
    );
    return unsubscribe;
  }, [focusedTaskId]);

  // The task that just gained focus is, by definition, being looked at now.
  useEffect(() => {
    if (!focusedTaskId) return;
    setUnread((current) => clearUnread(current, focusedTaskId));
  }, [focusedTaskId]);

  return unread;
}

/**
 * OS-notification half of the "finished while you weren't looking" feature
 * (daily-driver switch, task B): a second, self-contained subscription to
 * the same ~5s presence push `useUnreadTaskIds` watches, folding each push
 * through `notifyTransitionEvents` (lib/notifications.ts "- the exact same
 * transition edges the unread dot lights up on) and calling `app.notify`
 * for each. Deliberately a separate subscription rather than a callback
 * threaded through `useUnreadTaskIds`, matching that hook's own
 * self-contained pattern "- callers never fight over shared subscription
 * state. Call once (e.g. from App.tsx), not per sidebar row/board card.
 */
export function useTaskNotifications(
  focusedTaskId: string | null,
  getTaskTitle: (taskId: string) => string,
): void {
  const previousRef = useRef<PresenceChangedPayload>({});
  const focusedTaskIdRef = useRef(focusedTaskId);
  focusedTaskIdRef.current = focusedTaskId;
  const windowFocusedRef = useRef(
    typeof document === "undefined" ? true : document.hasFocus(),
  );
  const getTaskTitleRef = useRef(getTaskTitle);
  getTaskTitleRef.current = getTaskTitle;

  useEffect(() => {
    function onFocus(): void {
      windowFocusedRef.current = true;
    }
    function onBlur(): void {
      windowFocusedRef.current = false;
    }
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.harbormaster.core.onPresenceChanged(
      (payload) => {
        const previous = previousRef.current;
        previousRef.current = payload;
        if (notificationsDisabled(window.localStorage)) return;
        const events = notifyTransitionEvents({
          previous,
          next: payload,
          focusedTaskId: focusedTaskIdRef.current,
          windowFocused: windowFocusedRef.current,
        });
        for (const event of events) {
          void window.harbormaster.app.notify({
            taskId: event.taskId,
            title: getTaskTitleRef.current(event.taskId),
            body: event.body,
          });
        }
      },
    );
    return unsubscribe;
  }, []);
}

export function useManualRefresh(): { busy: boolean; refresh: () => void } {
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    if (busy) return;
    setBusy(true);
    const minimum = new Promise((resolve) => setTimeout(resolve, 400));
    void Promise.allSettled([window.harbormaster.core.refresh(), minimum]).then(
      () => setBusy(false),
    );
  }, [busy]);
  return { busy, refresh };
}
