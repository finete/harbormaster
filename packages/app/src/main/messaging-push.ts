// Small pure helpers behind main's task-messaging push (see index.ts's
// `watchMessagingFiles` and the `core:messaging-changed` channel), kept
// Electron-free so they can be unit tested.
import { createSingleFlight } from "./presence-push";

/**
 * Whether a change under `<stateDir>/messages` is the message log itself
 * (`messages.json`, including the rename that completes an atomic write).
 * The lock file, the per-task doorbell files and the attachment copies
 * change on every send/claim but carry nothing the renderer shows, so they
 * never trigger a push.
 */
export function isMessagesLogChange(filename: string | null): boolean {
  return filename === "messages.json";
}

export interface DedupedPusher {
  /**
   * Loads the current payload and sends it, unless it is identical to the
   * last one sent (`force` sends regardless). Single-flighted: overlapping
   * calls collapse into one trailing run, so a burst of triggers (a write
   * seen by both the in-process event and the file watcher) loads at most
   * twice and sends once when nothing changed. Never rejects.
   */
  push: (options?: { force?: boolean }) => Promise<void>;
  /** Forget the last-sent payload: call when a window fetched state itself, so the next push is never suppressed against a snapshot that window may not hold. */
  invalidate: () => void;
}

/**
 * "Load, then push only what changed" for one broadcast channel (the same
 * dedupe `pushBoardToWindows` applies to the board): the file watcher fires
 * for this process's own writes (already announced by a core event) and for
 * every external write alike, and each push re-renders the whole renderer.
 */
export function createDedupedPusher<T>(options: {
  load: () => Promise<T>;
  send: (payload: T) => void;
  onError?: (error: unknown) => void;
}): DedupedPusher {
  let lastJson: string | undefined;
  let forceNext = false;
  const run = createSingleFlight(
    async () => {
      const payload = await options.load();
      const json = JSON.stringify(payload);
      const force = forceNext;
      forceNext = false;
      if (!force && json === lastJson) return;
      lastJson = json;
      options.send(payload);
    },
    options.onError ?? (() => {}),
  );
  return {
    push: (pushOptions = {}) => {
      if (pushOptions.force) forceNext = true;
      return run();
    },
    invalidate: () => {
      lastJson = undefined;
    },
  };
}

/** Attachment pruning is cheap but pointless to repeat: at most this often. */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * "At most once per `intervalMs`" gate: `tryAcquire()` is true (and starts a
 * new window) when none ran yet or the last one is at least `intervalMs`
 * old. Used for the hourly attachment-prune tick riding the refresh loop.
 */
export function createIntervalGate(
  intervalMs: number,
  now: () => number = Date.now,
): { tryAcquire: () => boolean } {
  let last: number | undefined;
  return {
    tryAcquire() {
      const at = now();
      if (last !== undefined && at - last < intervalMs) return false;
      last = at;
      return true;
    },
  };
}
