// Utility: a `CoreLogger` that prints `[core:<scope>] message {json fields}`
// lines through a console-like sink. The app hands it `console`, so core's
// lines land in `<userData>/logs/main.log` with everything else main prints.

import type {
  CoreLogFields,
  CoreLogger,
  CoreLogScope,
} from "../contracts/logger.js";

/** The subset of `console` the logger prints through. */
export interface CoreLogSink {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

/** One log line: `[core:<scope>] message {"taskId":…}` (fields omitted when empty). */
export function formatCoreLogLine(
  scope: CoreLogScope,
  message: string,
  fields?: CoreLogFields,
): string {
  const defined = fields
    ? Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      )
    : {};
  const suffix =
    Object.keys(defined).length > 0 ? ` ${JSON.stringify(defined)}` : "";
  return `[core:${scope}] ${message}${suffix}`;
}

/** A logger printing formatted lines to `sink` (e.g. `console`). Never throws. */
export function consoleCoreLogger(sink: CoreLogSink): CoreLogger {
  const print =
    (level: keyof CoreLogSink) =>
    (scope: CoreLogScope, message: string, fields?: CoreLogFields) => {
      try {
        sink[level](formatCoreLogLine(scope, message, fields));
      } catch {
        // A broken sink must never break a core operation.
      }
    };
  return { info: print("info"), warn: print("warn"), error: print("error") };
}
