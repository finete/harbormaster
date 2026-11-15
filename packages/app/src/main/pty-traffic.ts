// Pty output accounting for the `[health]` lines (see health-monitor.ts):
// total bytes per session over the current health window (drained once a
// minute, top 3 by bytes reported) and a rolling last-second total for
// `[health] spike` lines. `record` sits on every pty `onData` chunk
// (ptySessions.ts), so it is a couple of map/array updates, nothing more.

export interface PtyTrafficEntry {
  sessionId: string;
  taskId: string | undefined;
  bytes: number;
}

export interface PtyTrafficWindow {
  totalBytes: number;
  /** The busiest sessions this window, most bytes first. */
  top: PtyTrafficEntry[];
}

export interface PtyTraffic {
  record(
    sessionId: string,
    taskId: string | undefined,
    bytes: number,
    nowMs?: number,
  ): void;
  /** Bytes recorded within the last ~second (100 ms buckets). */
  lastSecondBytes(nowMs?: number): number;
  /** The window's totals and top `topN` sessions, then starts a fresh window. */
  drainWindow(topN?: number): PtyTrafficWindow;
}

const BUCKET_MS = 100;
const BUCKETS = 10;

/** The `n` entries with the most bytes, most first (ties: insertion order). */
export function topByBytes(
  entries: Iterable<PtyTrafficEntry>,
  n: number,
): PtyTrafficEntry[] {
  return [...entries].sort((a, b) => b.bytes - a.bytes).slice(0, n);
}

export function createPtyTraffic(now: () => number = Date.now): PtyTraffic {
  let perSession = new Map<string, PtyTrafficEntry>();
  let totalBytes = 0;
  const bucketBytes = new Array<number>(BUCKETS).fill(0);
  const bucketStamp = new Array<number>(BUCKETS).fill(-1);

  function record(
    sessionId: string,
    taskId: string | undefined,
    bytes: number,
    nowMs: number = now(),
  ): void {
    totalBytes += bytes;
    const entry = perSession.get(sessionId);
    if (entry) entry.bytes += bytes;
    else perSession.set(sessionId, { sessionId, taskId, bytes });
    const slot = Math.floor(nowMs / BUCKET_MS);
    const idx = slot % BUCKETS;
    if (bucketStamp[idx] !== slot) {
      bucketStamp[idx] = slot;
      bucketBytes[idx] = 0;
    }
    bucketBytes[idx] = (bucketBytes[idx] ?? 0) + bytes;
  }

  function lastSecondBytes(nowMs: number = now()): number {
    const slot = Math.floor(nowMs / BUCKET_MS);
    let sum = 0;
    for (let i = 0; i < BUCKETS; i++) {
      const stamp = bucketStamp[i] ?? -1;
      if (stamp > slot - BUCKETS && stamp <= slot) sum += bucketBytes[i] ?? 0;
    }
    return sum;
  }

  function drainWindow(topN = 3): PtyTrafficWindow {
    const result = { totalBytes, top: topByBytes(perSession.values(), topN) };
    perSession = new Map();
    totalBytes = 0;
    return result;
  }

  return { record, lastSecondBytes, drainWindow };
}

/** The app-wide instance ptySessions.ts records into and the health monitor drains. */
export const ptyTraffic = createPtyTraffic();
