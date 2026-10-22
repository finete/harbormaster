// Renderer data layer over the narrow `window.harbormaster.core` IPC bridge
// (see /src/preload/api.ts and /src/main/index.ts). Replaces the old
// mock.ts: the board is now fetched from @harbormaster/core on mount and
// kept live via the "board-changed" push channel — no frontend reads or
// writes state files directly (see /docs/design-decisions.md "Core is
// headless").
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
import { createSharedStore } from "./lib/shared-store";
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
 * The one shared board subscription (see lib/shared-store.ts): fetched once
 * when the first `useBoard` caller mounts, then replaced wholesale on every
 * "board-changed" push (the core always sends the full column list, so there
 * is nothing to merge). Released when the last caller unmounts.
 */
const boardStore = createSharedStore<BoardColumn[]>([], (set) => {
  let pushed = false;
  void window.harbormaster.core.listBoard().then((cols) => {
    // A push that already landed is at least as fresh as this fetch.
    if (!pushed) set(cols);
  });
  return window.harbormaster.core.onBoardChanged((payload) => {
    pushed = true;
    set(payload.columns);
  });
});

/**
 * The one shared presence subscription to the ~5s main-process presence
 * poll (see /src/main/index.ts's `pollPresenceOnce`). Replaced wholesale on
 * every push (the main process always sends the full non-done-task map);
 * an unchanged push doesn't notify anyone.
 */
const presenceStore = createSharedStore<PresenceChangedPayload>({}, (set) =>
  window.harbormaster.core.onPresenceChanged((payload) => set(payload)),
);

/** Subscribes to the live board (shared across every caller). */
export function useBoard(): BoardColumn[] {
  return useSyncExternalStore(boardStore.subscribe, boardStore.getSnapshot);
}

/** Subscribes to the live presence map (shared across every caller). */
export function usePresenceMap(): PresenceChangedPayload {
  return useSyncExternalStore(
    presenceStore.subscribe,
    presenceStore.getSnapshot,
  );
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
 * Each caller keeps its own unread Set (sidebar rows and board cards don't
 * fight over one state), but all ride the single shared presence store.
 * Never persisted "-" a fresh launch starts clean.
 */
export function useUnreadTaskIds(
  focusedTaskId: string | null,
): ReadonlySet<string> {
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set());
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
    // Rides the shared presence store (one IPC subscription app-wide); it
    // only notifies on a *changed* push, so an idle 5s poll costs nothing.
    // Baseline = whatever the shared store already holds, so a late mount
    // doesn't treat already-blocked tasks as fresh transitions.
    previousRef.current = presenceStore.getSnapshot();
    const unsubscribe = presenceStore.subscribe(() => {
      const payload = presenceStore.getSnapshot();
      // Capture the pre-push snapshot *before* touching the ref: React's
      // `setUnread` updater below can run after this callback returns
      // (it isn't a React-originated event, so updates aren't
      // synchronously flushed), and by then `previousRef.current =
      // payload` would already have overwritten it "-" comparing the new
      // push against itself and never seeing a transition.
      const previous = previousRef.current;
      previousRef.current = payload;
      const focused = focusedTaskIdRef.current;
      setUnread((current) =>
        applyUnreadTransition(current, {
          previous,
          next: payload,
          focusedTaskId: focused,
          windowFocused: windowFocusedRef.current,
        }),
      );
    });
    return unsubscribe;
  }, []);

  // The task that just gained focus is, by definition, being looked at now.
  useEffect(() => {
    if (!focusedTaskId) return;
    setUnread((current) => clearUnread(current, focusedTaskId));
  }, [focusedTaskId]);

  return unread;
}

/**
 * OS-notification half of the "finished while you weren't looking" feature
 * (daily-driver switch, task B): a separate listener on the same shared
 * ~5s presence store `useUnreadTaskIds` watches, folding each push
 * through `notifyTransitionEvents` (lib/notifications.ts "- the exact same
 * transition edges the unread dot lights up on) and calling `app.notify`
 * for each. Deliberately a separate listener rather than a callback
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
    previousRef.current = presenceStore.getSnapshot();
    const unsubscribe = presenceStore.subscribe(() => {
      const payload = presenceStore.getSnapshot();
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
    });
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

/** What the connectivity banner should render; "hidden" renders nothing (the common, healthy case). */
export type ConnectivityBannerState =
  | "hidden"
  | "offline"
  | "reconnecting"
  | "restored";

/**
 * Drives the one neutral offline banner (see ConnectivityBanner.tsx): the
 * main process's offline/reconnecting/restored push channel is the source
 * of truth (it is the one that actually talked, or failed to talk, to gh),
 * but the renderer's own `window` online/offline events are layered on top
 * as a fast local hint so the banner appears the instant the OS reports no
 * network, without waiting for the next ~10s offline-poll tick. "restored"
 * auto-hides itself after a few seconds; every other visible state stays
 * until main says otherwise.
 */
export function useConnectivity(): ConnectivityBannerState {
  const [mainState, setMainState] = useState<
    "online" | "offline" | "reconnecting" | "restored"
  >("online");
  const [localOffline, setLocalOffline] = useState(() =>
    typeof navigator === "undefined" ? false : !navigator.onLine,
  );
  const [restoredHidden, setRestoredHidden] = useState(false);

  useEffect(
    () =>
      window.harbormaster.core.onConnectivityChanged((state) => {
        setMainState(state);
        if (state === "restored") setRestoredHidden(false);
      }),
    [],
  );

  useEffect(() => {
    const onOffline = (): void => setLocalOffline(true);
    const onOnline = (): void => setLocalOffline(false);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  useEffect(() => {
    if (mainState !== "restored") return;
    const timer = window.setTimeout(() => setRestoredHidden(true), 3_000);
    return () => window.clearTimeout(timer);
  }, [mainState]);

  if (mainState === "restored") {
    return restoredHidden ? "hidden" : "restored";
  }
  if (mainState === "reconnecting") return "reconnecting";
  if (mainState === "offline" || localOffline) return "offline";
  return "hidden";
}
