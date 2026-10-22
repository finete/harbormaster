// Small pure helpers behind main's presence poll (see index.ts's
// `pollPresenceOnce`), kept Electron-free so they can be unit tested.

/**
 * Wraps an async task so at most one run is ever in flight. A call that
 * arrives mid-run doesn't start a concurrent run — it schedules exactly one
 * trailing rerun (however many calls arrived) once the current one settles,
 * so a trigger that fired because something just changed (a pty exit) is
 * never answered by a run that read the old state. Every returned promise
 * resolves (never rejects) once the work it asked for is done; a failed run
 * is reported through `onError` instead of surfacing as an unhandled
 * rejection.
 */
export function createSingleFlight(
  run: () => Promise<void>,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  let rerun = false;
  return () => {
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        do {
          rerun = false;
          try {
            await run();
          } catch (error) {
            onError(error);
          }
        } while (rerun);
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
}

/**
 * Per-target "only push what changed" bookkeeping for a push channel the
 * renderer has no initial fetch for (it learns state only from pushes): an
 * identical payload is suppressed per target, but never for longer than
 * `maxSuppressMs`, so a push the renderer missed (sent while it was still
 * loading) heals on its own. `reset(target)` forgets a target — call it when
 * that renderer (re)loads so its next push always goes out.
 */
export function createPushDedupe(options: {
  maxSuppressMs: number;
  now?: () => number;
}): {
  shouldSend: (target: number, json: string) => boolean;
  reset: (target: number) => void;
} {
  const now = options.now ?? Date.now;
  const last = new Map<number, { json: string; at: number }>();
  return {
    shouldSend(target, json) {
      const at = now();
      const previous = last.get(target);
      if (
        previous &&
        previous.json === json &&
        at - previous.at < options.maxSuppressMs
      ) {
        return false;
      }
      last.set(target, { json, at });
      return true;
    },
    reset(target) {
      last.delete(target);
    },
  };
}
