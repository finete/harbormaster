// Opt-in verbose main-process logging: `HARBORMASTER_LOG=debug`. Off by
// default, `debugLog` is a no-op, so hot paths (per-chunk pty data, every
// IPC call, every presence tick) cost one boolean check. On, each call is a
// `[debug:<scope>] …` line through `console.log` (teed to main.log by
// app-log.ts). Callers that would build an expensive message first should
// guard on `isDebugLogging()`.

/** Whether `env` turns debug logging on (`HARBORMASTER_LOG=debug`, case-insensitive). */
export function debugLoggingRequested(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (env.HARBORMASTER_LOG ?? "").trim().toLowerCase() === "debug";
}

let enabled: boolean | undefined;

/** Cached `debugLoggingRequested(process.env)`: read once, the switch is per run. */
export function isDebugLogging(): boolean {
  enabled ??= debugLoggingRequested(process.env);
  return enabled;
}

/** Tests only: force the switch (or `undefined` to re-read the env). */
export function setDebugLoggingForTests(value: boolean | undefined): void {
  enabled = value;
}

/** `[debug:<scope>] …args` via `console.log`, only when `HARBORMASTER_LOG=debug`. */
export function debugLog(scope: string, ...args: unknown[]): void {
  if (!isDebugLogging()) return;
  console.log(`[debug:${scope}]`, ...args);
}
