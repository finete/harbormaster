// Utility: timed operation spans for the core log (see contracts/logger.ts).
// One completion line per operation: `<op> ok|failed` with `ms`, plus the
// error's first line on failure. The wrapped operation's result or error
// passes through untouched: logging never changes behavior.

import type {
  CoreLogFields,
  CoreLogger,
  CoreLogScope,
  CoreOperation,
} from "../contracts/logger.js";

const MAX_ERROR_LENGTH = 600;

/**
 * An error's message on one line, bounded (never a stack). Multi-line git
 * errors keep their lines joined with " / "; an over-long one keeps its
 * head and its tail, where git puts the `fatal:` reason.
 */
export function logErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" / ");
  if (line.length <= MAX_ERROR_LENGTH) return line;
  const half = MAX_ERROR_LENGTH / 2;
  return `${line.slice(0, half)} … ${line.slice(-half)}`;
}

/** Milliseconds since `start` (a `performance.now()` reading), rounded. */
export function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

/**
 * Run `run`, then log one line: `<op> ok` (info) or `<op> failed` (warn)
 * with `ms`, `outcome` and, on failure, `error`. Rethrows the original error.
 */
export async function timed<T>(
  logger: CoreLogger,
  scope: CoreLogScope,
  op: CoreOperation,
  fields: CoreLogFields,
  run: () => Promise<T>,
  /** Extra fields read off the result (counts, the created path). */
  resultFields?: (result: T) => CoreLogFields,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await run();
    logger.info(scope, `${op} ok`, {
      op,
      ...fields,
      ...resultFields?.(result),
      ms: elapsedMs(start),
      outcome: "ok",
    });
    return result;
  } catch (error) {
    logger.warn(scope, `${op} failed`, {
      op,
      ...fields,
      ms: elapsedMs(start),
      outcome: "failed",
      error: logErrorMessage(error),
    });
    throw error;
  }
}

/** Per-method span spec: the operation name and the safe fields taken from its arguments. */
export type TimedMethodSpecs<T> = {
  [K in keyof T]?: {
    op: CoreOperation;
    scope: CoreLogScope;
    // biome-ignore lint/suspicious/noExplicitAny: arguments of an arbitrary contract method
    fields: (...args: any[]) => CoreLogFields;
    // biome-ignore lint/suspicious/noExplicitAny: result of an arbitrary contract method
    result?: (result: any) => CoreLogFields;
  };
};

/**
 * `target` with the methods named in `specs` wrapped in `timed` spans; every
 * other member passes through (bound to `target`). Used by `createCore` to
 * time every git / GitHub call of an access service, whichever caller makes
 * it, without touching the callers.
 */
export function withTimedMethods<T extends object>(
  target: T,
  logger: CoreLogger,
  specs: TimedMethodSpecs<T>,
): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;
      const spec = specs[property as keyof T];
      if (!spec) return value.bind(object);
      return (...args: unknown[]) =>
        timed(
          logger,
          spec.scope,
          spec.op,
          spec.fields(...args),
          () => Promise.resolve(value.apply(object, args)),
          spec.result,
        );
    },
  });
}
