// A `CoreLogger` that records every line, for asserting core's operation log.

import type {
  CoreLogFields,
  CoreLogger,
  CoreLogScope,
} from "../../src/contracts/logger.js";

export interface CapturedLine {
  level: "info" | "warn" | "error";
  scope: CoreLogScope;
  message: string;
  fields: CoreLogFields;
}

export interface CaptureLogger extends CoreLogger {
  lines: CapturedLine[];
  /** Lines whose message starts with `prefix` (e.g. `"worktree.create"`). */
  find(prefix: string): CapturedLine[];
}

export function captureLogger(): CaptureLogger {
  const lines: CapturedLine[] = [];
  const record =
    (level: CapturedLine["level"]) =>
    (scope: CoreLogScope, message: string, fields: CoreLogFields = {}) => {
      lines.push({ level, scope, message, fields });
    };
  return {
    lines,
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    find: (prefix) => lines.filter((line) => line.message.startsWith(prefix)),
  };
}
