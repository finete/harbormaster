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

/**
 * The retired localStorage escape hatch (`harbormaster.notifications =
 * "off"`), replaced by the `notifications.enabled` setting (docs/settings.md
 * S11). Read only to migrate it once, then removed.
 */
export const NOTIFICATIONS_STORAGE_KEY = "harbormaster.notifications";

/**
 * The legacy escape hatch's value, `null` when unset or unreadable (a
 * storage read that throws, or no storage at all, never blocks
 * notifications).
 */
export function legacyNotificationsValue(
  storage: Pick<Storage, "getItem"> | undefined,
): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(NOTIFICATIONS_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Settings state the notification decision reads. */
export interface NotificationSettings {
  /** Effective `notifications.enabled` (`undefined` until settings load). */
  value: unknown;
  /** Whether config.json sets `notifications.enabled`. */
  configured: boolean;
}

/**
 * Whether to show OS notifications: the `notifications.enabled` setting;
 * until the one-time migration has run (config unset), a legacy "off" in
 * localStorage still counts as off. Main's `HARBORMASTER_NOTIFICATIONS=off`
 * kill switch applies on top, in the main process.
 */
export function notificationsEnabled(
  settings: NotificationSettings,
  legacy: string | null,
): boolean {
  if (settings.value === false) return false;
  if (!settings.configured && legacy === "off") return false;
  return true;
}

/**
 * The one-time migration of the legacy escape hatch: a legacy "off" with
 * the setting unset becomes `notifications.enabled = false` in config.json;
 * any legacy value is then removed (the setting wins when both exist).
 */
export function notificationsMigration(
  legacy: string | null,
  configured: boolean,
): { writeOff: boolean; clearLegacy: boolean } {
  if (legacy === null) return { writeOff: false, clearLegacy: false };
  return { writeOff: legacy === "off" && !configured, clearLegacy: true };
}
