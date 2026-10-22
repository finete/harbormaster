/**
 * Id-keyed fan-out for per-session pty pushes (`pty:data`, `pty:exit`).
 *
 * Without this, every terminal pane registered its own `ipcRenderer.on`
 * listener and dropped chunks for other sessions, so each chunk crossed the
 * preload → page context bridge once per open pane (N panes × M streaming
 * sessions). The router holds ONE underlying subscription per channel,
 * created lazily on the first listener and released when the last one
 * leaves, and delivers each event only to listeners for its `id` (plus any
 * unfiltered "all sessions" listeners, kept for API compatibility).
 *
 * Pure and transport-agnostic: the preload passes an `ipcRenderer`-backed
 * `subscribe`; unit tests pass a fake.
 */

export type IdEventListener<E> = (event: E) => void;

export interface IdRouter<E extends { id: string }> {
  /**
   * Subscribe to events for session `id`, or to every session when `id` is
   * omitted. Returns an idempotent unsubscribe.
   */
  on(listener: IdEventListener<E>, id?: string): () => void;
  /** Number of registered listeners (all ids + unfiltered). */
  listenerCount(): number;
}

export function createIdRouter<E extends { id: string }>(
  subscribe: (dispatch: (event: E) => void) => () => void,
): IdRouter<E> {
  const byId = new Map<string, Set<IdEventListener<E>>>();
  const unfiltered = new Set<IdEventListener<E>>();
  let release: (() => void) | undefined;

  function dispatch(event: E): void {
    for (const listener of unfiltered) listener(event);
    const listeners = byId.get(event.id);
    if (listeners) for (const listener of listeners) listener(event);
  }

  function releaseIfIdle(): void {
    if (release && unfiltered.size === 0 && byId.size === 0) {
      const r = release;
      release = undefined;
      r();
    }
  }

  return {
    on(listener, id) {
      if (id === undefined) {
        unfiltered.add(listener);
      } else {
        let set = byId.get(id);
        if (!set) {
          set = new Set();
          byId.set(id, set);
        }
        set.add(listener);
      }
      if (!release) release = subscribe(dispatch);

      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (id === undefined) {
          unfiltered.delete(listener);
        } else {
          const set = byId.get(id);
          if (set) {
            set.delete(listener);
            if (set.size === 0) byId.delete(id);
          }
        }
        releaseIfIdle();
      };
    },
    listenerCount() {
      let n = unfiltered.size;
      for (const set of byId.values()) n += set.size;
      return n;
    },
  };
}
