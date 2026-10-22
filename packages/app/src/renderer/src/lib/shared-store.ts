// Ref-counted, module-level external store for one IPC push channel, read
// through React's `useSyncExternalStore`. Every hook instance (App, Sidebar,
// Board, each TaskWorkspace, ...) shares ONE underlying subscription per
// channel instead of opening its own IPC listener + initial fetch.
//
// Lifecycle is lazy and ref-counted, so nothing is registered at module
// scope (HMR-safe: a hot-reloaded module never stacks a second listener):
// the source starts on the first subscriber and stops when the last one
// leaves. Equal payloads (structural, via JSON) don't notify, so React sees
// the same snapshot reference and bails out of the re-render.
//
// Free of React/DOM so the ref-counting and equality rules are unit-testable
// in node (see tests/shared-store.test.ts).

export interface SharedStore<T> {
  /** `useSyncExternalStore`-compatible subscribe (stable identity). */
  subscribe: (listener: () => void) => () => void;
  /** `useSyncExternalStore`-compatible snapshot getter (stable identity). */
  getSnapshot: () => T;
  /** Number of live subscribers (tests/diagnostics). */
  subscriberCount: () => number;
}

/**
 * Starts the underlying source. `set` publishes a new value (ignored when
 * equal to the current one); the returned function stops the source.
 */
export type SharedSource<T> = (set: (value: T) => void) => () => void;

export function createSharedStore<T>(
  initial: T,
  start: SharedSource<T>,
): SharedStore<T> {
  let value = initial;
  let serialized = safeSerialize(initial);
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  // Bumped on every start/stop so a stopped source's late `set` (e.g. an
  // in-flight initial fetch) can't publish into a later session.
  let generation = 0;

  function publish(gen: number, next: T): void {
    if (gen !== generation) return;
    const nextSerialized = safeSerialize(next);
    if (
      next === value ||
      (nextSerialized !== null && nextSerialized === serialized)
    ) {
      return;
    }
    value = next;
    serialized = nextSerialized;
    for (const listener of Array.from(listeners)) listener();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (listeners.size === 1 && stop === null) {
      const gen = ++generation;
      stop = start((next) => publish(gen, next));
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0 && stop !== null) {
        const current = stop;
        stop = null;
        generation++;
        current();
      }
    };
  }

  return {
    subscribe,
    getSnapshot: () => value,
    subscriberCount: () => listeners.size,
  };
}

function safeSerialize(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}
