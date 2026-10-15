// Pure "when to show an OS notification" decision logic (daily-driver
// switch, task B). Reuses `unreadTransitions` from lib/unread.ts so a task
// is notified on exactly the same edges it is marked unread on — one
// notification per task per unread episode, cleared the moment the task is
// focused (see unread.ts's `clearUnread`, called from the owning hook).
// Kept free of React/DOM/Electron so it is unit-testable without either a
// browser or a main process (see tests/notifications.test.ts). The owning
// hook (useTaskNotifications in core-client.ts) calls this on every
// presence push and turns each event into an `app.notify` IPC call.
import { type UnreadTransitionInput, unreadTransitions } from "./unread";

export interface NotifyEvent {
  taskId: string;
  /** "finished" for a runningTurn true->false transition; the blocked note
   * (or a generic fallback) for a presence outcome arriving blocked. */
  body: string;
}

/**
 * Tasks newly unread given this presence push, paired with the notification
 * body each should show. See `unreadTransitions` for the transition rule
 * itself (same edges, same "don't notify what you're looking at" guard).
 */
export function notifyTransitionEvents(
  input: UnreadTransitionInput,
): NotifyEvent[] {
  return unreadTransitions(input).map((taskId) => {
    const ended = input.next[taskId]?.ended;
    if (ended?.status === "blocked") {
      const note = ended.note?.trim();
      return { taskId, body: note ? note : "needs your attention" };
    }
    return { taskId, body: "finished" };
  });
}

/** localStorage key for the notifications escape hatch (no settings UI yet). */
export const NOTIFICATIONS_STORAGE_KEY = "harbormaster.notifications";

/**
 * Whether OS notifications are turned off via the `harbormaster.notifications
 * = "off"` localStorage escape hatch. Accepts any storage-shaped object (just
 * `getItem`) so it is testable without a real `Storage`; a storage read that
 * throws (private-browsing-style quota errors, a non-browser caller passing
 * `undefined`) is treated as "not disabled" rather than failing notifications
 * entirely.
 */
export function notificationsDisabled(
  storage: Pick<Storage, "getItem"> | undefined,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(NOTIFICATIONS_STORAGE_KEY) === "off";
  } catch {
    return false;
  }
}
