// Utility: bounded-parallel iteration (pi-home's reconcile worker pool),
// shared by any layer that fans out independent slow I/O.

/**
 * Run `work` over `items` with at most `limit` calls in flight; resolves
 * once every call settled. A rejecting call rejects the whole run, so
 * callers that want "one failure never stops the rest" catch inside `work`.
 */
export async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await work(items[index] as T, index);
    }
  };
  const size = Math.min(Math.max(Math.trunc(limit), 1), items.length);
  await Promise.all(Array.from({ length: size }, () => worker()));
}

/** Thrown by {@link withTimeout} when the deadline passes first. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * `promise`, or a {@link TimeoutError} once `ms` pass first. The underlying
 * work is not cancelled (pass a timeout to the work itself to kill it);
 * this only bounds how long the caller waits.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
