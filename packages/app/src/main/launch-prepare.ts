// The launcher's side of two LaunchSpec fields core cannot act on itself
// (accessor separation: core never writes files or watches ptys):
//
// - `prepare`: files the harness needs before it starts (Cursor's
//   per-session plugin directory: hooks + MCP, docs/harness-additions.md
//   C2), written right before the spawn.
// - `hookStatus`: the program reports no status on its pty (Cursor, C3,
//   C9). The attachment is registered at spawn as `working` "Starting…"
//   (so nothing is typed into a TUI that would drop it), and reported
//   ready either by the harness's session-start hook (`ready: "hook"`) or,
//   when none will fire (a resumed chat), once the pty has been quiet for
//   `HOOK_PRESENCE_QUIET_MS` (`ready: "quiet"`).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { HOOK_PRESENCE_QUIET_MS } from "@harbormaster/core";

/** `LaunchSpec.prepare` (core's contract, structurally). */
export interface LaunchPrepareLike {
  dir: string;
  files: Record<string, string>;
}

/** Writes `prepare.files` under `prepare.dir` (parents created, existing files replaced); never outside it. */
export function materializeLaunchFiles(prepare: LaunchPrepareLike): void {
  if (!isAbsolute(prepare.dir)) {
    throw new Error(`launch files need an absolute directory: ${prepare.dir}`);
  }
  const root = normalize(prepare.dir);
  for (const [relative, text] of Object.entries(prepare.files)) {
    const path = normalize(join(root, relative));
    if (isAbsolute(relative) || !path.startsWith(root + sep)) {
      throw new Error(`launch file escapes its directory: ${relative}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

export interface HookReadyWatcherOptions {
  /** Called once: the program is ready for input. */
  onReady: () => void;
  quietMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * For `hookStatus.ready === "quiet"`: `feed()` on every output chunk;
 * `onReady` fires once, `quietMs` after the last chunk (never before the
 * first one). `dispose()` stops it (exit).
 */
export function createHookReadyWatcher(options: HookReadyWatcherOptions): {
  feed: () => void;
  dispose: () => void;
} {
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const quietMs = options.quietMs ?? HOOK_PRESENCE_QUIET_MS;
  let timer: unknown;
  let done = false;
  return {
    feed: () => {
      if (done) return;
      if (timer !== undefined) clearTimer(timer);
      timer = setTimer(() => {
        timer = undefined;
        if (done) return;
        done = true;
        options.onReady();
      }, quietMs);
    },
    dispose: () => {
      done = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}
