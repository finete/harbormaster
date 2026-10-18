import { useEffect, useState } from "react";

/** Relative times ("now", "3m", ...) re-render at least this often. */
export const CLOCK_TICK_MS = 30_000;

/**
 * Wall-clock `Date.now()` that re-renders its caller every `intervalMs`.
 * Shared by the sidebar rail (SidebarTaskRow's relative "3m"/"2h" column)
 * and the board's cards (TaskCard's time indicator), so both tick on the
 * same cadence.
 */
export function useNow(intervalMs: number = CLOCK_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
