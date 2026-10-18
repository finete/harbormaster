// Per-session pty output coalescing (main process).
//
// node-pty delivers output in whatever chunk sizes the OS read returns —
// under a flooding process (an agent streaming tool output, `cat` of a big
// file, `yes`) that is tens of thousands of tiny chunks a second. Forwarding
// each one as its own IPC message floods the renderer's main thread with
// per-message task overhead (deserialize, dispatch to every pane's listener,
// an xterm.write each), starving input/hover handling for seconds (measured:
// ~45k `pty:data` messages/s, hover-to-frame p95 > 2.5s — see
// e2e/perf-flood.spec.ts). This is the xterm.js flow-control guide / VS
// Code practice: buffer per session and flush at most once per frame-ish
// interval as one concatenated string. Pure (no Electron/node-pty imports)
// so it is unit-testable with fake timers.

export interface PtyDataBatcherOptions {
  /** Receives each coalesced flush, in arrival order. */
  send: (data: string) => void;
  /** Max time a chunk waits before being flushed. */
  intervalMs?: number;
  /**
   * Flush immediately once this many chars are buffered, so a flood can
   * never build an unbounded single message between timer ticks.
   */
  maxBufferedChars?: number;
  /** Injectable for tests; default `setTimeout`/`clearTimeout`. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface PtyDataBatcher {
  /** Buffers a chunk; schedules (or performs, past the size guard) a flush. */
  push: (data: string) => void;
  /** Sends whatever is pending right now (no-op when empty). Call before an exit event so output is never reordered after it. */
  flush: () => void;
  /** Drops anything pending and cancels the timer; later pushes are ignored. */
  dispose: () => void;
}

export const PTY_BATCH_INTERVAL_MS = 16;
export const PTY_BATCH_MAX_CHARS = 64 * 1024;

export function createPtyDataBatcher(
  options: PtyDataBatcherOptions,
): PtyDataBatcher {
  const intervalMs = options.intervalMs ?? PTY_BATCH_INTERVAL_MS;
  const maxChars = options.maxBufferedChars ?? PTY_BATCH_MAX_CHARS;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number): unknown => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown): void =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  let chunks: string[] = [];
  let bufferedChars = 0;
  let timer: unknown;
  let disposed = false;

  function cancelTimer(): void {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  }

  function flush(): void {
    cancelTimer();
    if (disposed || chunks.length === 0) return;
    const data = chunks.length === 1 ? (chunks[0] as string) : chunks.join("");
    chunks = [];
    bufferedChars = 0;
    options.send(data);
  }

  return {
    push(data: string): void {
      if (disposed || data.length === 0) return;
      chunks.push(data);
      bufferedChars += data.length;
      if (bufferedChars >= maxChars) {
        flush();
        return;
      }
      if (timer === undefined) {
        timer = setTimer(() => {
          timer = undefined;
          flush();
        }, intervalMs);
      }
    },
    flush,
    dispose(): void {
      cancelTimer();
      disposed = true;
      chunks = [];
      bufferedChars = 0;
    },
  };
}

// --- Flow control ----------------------------------------------------------
//
// Batching alone bounds the *message* rate, not the byte rate: an unbounded
// producer (measured ~50M chars/s from a flooding process) still outruns
// xterm's parser, whose internal write queue then grows without limit (and
// past 50MB xterm starts discarding data). Per the xterm.js flow-control
// guide, the renderer acknowledges each chunk once xterm has parsed it, and
// main pauses the pty while too much is in flight, resuming once the
// renderer has caught up. A paused pty simply blocks the writing process
// (exactly like a slow real terminal) - no output is ever dropped.

export interface PtyFlowControlOptions {
  pause: () => void;
  resume: () => void;
  /** Pause once this many sent-but-unacknowledged chars are outstanding. */
  highWatermark?: number;
  /** Resume once outstanding chars drop back below this. */
  lowWatermark?: number;
}

export interface PtyFlowControl {
  /** Record `chars` handed to the renderer. */
  sent: (chars: number) => void;
  /** Record `chars` the renderer reports as fully processed. */
  acknowledged: (chars: number) => void;
  readonly paused: boolean;
  readonly outstanding: number;
}

export const PTY_FLOW_HIGH_WATERMARK = 256 * 1024;
export const PTY_FLOW_LOW_WATERMARK = 64 * 1024;

export function createPtyFlowControl(
  options: PtyFlowControlOptions,
): PtyFlowControl {
  const high = options.highWatermark ?? PTY_FLOW_HIGH_WATERMARK;
  const low = options.lowWatermark ?? PTY_FLOW_LOW_WATERMARK;
  let outstanding = 0;
  let paused = false;
  return {
    sent(chars: number): void {
      outstanding += chars;
      if (!paused && outstanding > high) {
        paused = true;
        options.pause();
      }
    },
    acknowledged(chars: number): void {
      if (!Number.isFinite(chars) || chars <= 0) return;
      outstanding = Math.max(0, outstanding - chars);
      if (paused && outstanding < low) {
        paused = false;
        options.resume();
      }
    },
    get paused(): boolean {
      return paused;
    },
    get outstanding(): number {
      return outstanding;
    },
  };
}
