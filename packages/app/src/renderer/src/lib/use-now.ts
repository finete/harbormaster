import { useSyncExternalStore } from "react";
import { createSharedStore, type SharedStore } from "./shared-store";

/** Relative times ("now", "3m", ...) re-render at least this often. */
export const CLOCK_TICK_MS = 30_000;

// One shared clock per interval (module-level, ref-counted through
// createSharedStore): every TaskCard / sidebar row ticking at the same
// cadence shares ONE setInterval, started on the first subscriber and
// cleared when the last unmounts (HMR-safe: nothing runs at module scope).
const clocks = new Map<number, SharedStore<number>>();

/** The shared clock store for `intervalMs` (exported for tests). */
export function sharedClock(intervalMs: number): SharedStore<number> {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = createSharedStore<number>(Date.now(), (set) => {
      // Restarting after an idle gap: don't hand out a stale time.
      set(Date.now());
      const timer = setInterval(() => set(Date.now()), intervalMs);
      return () => clearInterval(timer);
    });
    clocks.set(intervalMs, clock);
  }
  return clock;
}

/**
 * Wall-clock `Date.now()` that re-renders its caller every `intervalMs`.
 * Shared by the sidebar rail (SidebarTaskRow's relative "3m"/"2h" column)
 * and the board's cards (TaskCard's time indicator), so both tick on the
 * same cadence — off one shared timer rather than one per caller.
 */
export function useNow(intervalMs: number = CLOCK_TICK_MS): number {
  const clock = sharedClock(intervalMs);
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot);
}
