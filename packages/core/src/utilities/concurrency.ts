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
