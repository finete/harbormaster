// The launcher's side of two LaunchSpec fields core cannot act on itself
// (accessor separation: core never writes files or watches ptys):
//
// - `prepare`: files the harness needs before it starts (Cursor's
//   per-session plugin directory: hooks + MCP, docs/harness-additions.md
//   C2), written right before the spawn.
// - `promptFile`: a long initial prompt, written where the arguments point
//   (it never travels as an argument: see `launchRefusal`).
// - `hookStatus`: the program reports no status on its pty (Cursor, C3,
//   C9). The attachment is registered at spawn as `working` "Starting…"
//   (so nothing is typed into a TUI that would drop it), and reported
//   ready either by the harness's session-start hook (`ready: "hook"`) or,
//   when none will fire (a resumed chat), once the pty has been quiet for
//   `HOOK_PRESENCE_QUIET_MS` (`ready: "quiet"`).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import {
  HOOK_PRESENCE_QUIET_MS,
  MAX_LAUNCH_ARG_CHARS,
} from "@harbormaster/core";

/** `LaunchSpec.prepare` (core's contract, structurally). */
export interface LaunchPrepareLike {
  dir: string;
  files: Record<string, string>;
}

/** The parts of a `LaunchSpec` the launcher acts on before spawning (structural). */
export interface LaunchSpecFilesLike {
  args: readonly string[];
  prepare?: LaunchPrepareLike;
  promptFile?: { path: string; text: string };
}

/**
 * Why this spec must not be spawned, or `undefined`. An argument of
 * `MAX_LAUNCH_ARG_CHARS`+ gets an interpreter + script launch SIGKILLed at
 * exec by a managed Mac's endpoint security (943+ chars, seen with
 * SentinelOne), so the launcher refuses it up front instead of spawning a
 * process that dies before it runs. Core's adapters never build one (a long
 * prompt travels as `promptFile`); this is the last line of defense.
 */
export function launchRefusal(spec: LaunchSpecFilesLike): string | undefined {
  const index = spec.args.findIndex(
    (arg) => arg.length >= MAX_LAUNCH_ARG_CHARS,
  );
  if (index === -1) return undefined;
  const arg = spec.args[index] ?? "";
  return `Launch refused: argument ${index + 1} is ${arg.length} characters (limit ${MAX_LAUNCH_ARG_CHARS - 1}); managed Macs kill a program started with an argument this long ("${arg.slice(0, 40)}…").`;
}

/** Writes everything a spec needs on disk before its spawn: `prepare` files and the prompt file. */
export function materializeLaunchSpecFiles(spec: LaunchSpecFilesLike): void {
  if (spec.prepare) materializeLaunchFiles(spec.prepare);
  if (spec.promptFile) {
    if (!isAbsolute(spec.promptFile.path)) {
      throw new Error(
        `the prompt file needs an absolute path: ${spec.promptFile.path}`,
      );
    }
    mkdirSync(dirname(spec.promptFile.path), { recursive: true });
    writeFileSync(spec.promptFile.path, spec.promptFile.text);
  }
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
