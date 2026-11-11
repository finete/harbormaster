// Narrow pty resource-access wrapper for the main process.
//
// This is a *skeleton* concern, not core's harness-adapter boundary: the real
// Pi-session pty lifecycle (per /docs/design-decisions.md and
// /docs/design-decisions.md "Layering") will live behind packages/core's Access layer
// once sessions are wired through the command API. For now this proves the
// xterm <-> node-pty <-> IPC plumbing with a plain `$SHELL` process.
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import os from "node:os";
import path, { join } from "node:path";
import {
  ProgramStatusParser,
  type ProgramStatusReport,
} from "@harbormaster/core";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { app } from "electron";
import * as pty from "node-pty";
import { bufferTail } from "../shared/terminal-tail";
import {
  createPtyDataBatcher,
  createPtyFlowControl,
  type PtyDataBatcher,
  type PtyFlowControl,
} from "./pty-data-batcher";
import { buildPtyEnv } from "./pty-env";
import { releasePty, spawnWithFdHygiene } from "./pty-fd-hygiene";
import {
  createTerminalModeTracker,
  type TerminalModeTracker,
} from "./terminal-mode-tracker";

export interface PtySessionCallbacks {
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
}

/**
 * Mutable output routing for one session, kept on the session record so a
 * paneless background session can be rebound to a renderer later
 * (`attachPrimarySession`) without tearing down its single `onData`/`onExit`
 * pty subscription. `sink`/`exitSink` always exist; `flow`/`batcher` exist
 * only while a renderer is actually attached — a background session must
 * never pause the pty (no acks will ever come for it), so it has neither.
 */
interface SessionIO {
  /** Receives every chunk from the pty's `onData`, in arrival order. */
  sink: (data: string) => void;
  /** Receives the pty's exit code exactly once. */
  exitSink: (exitCode: number) => void;
  /** Pauses/resumes the pty against renderer backpressure (see pty-data-batcher.ts); present only while attached. */
  flow?: PtyFlowControl;
  /** Coalesces output into ~16ms flushes for the attached renderer; present only while attached. */
  batcher?: PtyDataBatcher;
}

/** A background (paneless) primary session's screen mirror: kept current from the pty's own output so a later `attachPrimarySession` can hand the attaching renderer a snapshot of what it missed. Disposed the instant a renderer attaches — it is pointless once real output streams straight through. */
interface HeadlessHost {
  terminal: HeadlessTerminal;
  serialize: SerializeAddon;
}

/** Default terminal size for a background-launched primary session, before any renderer has attached to resize it (wave-2 task brief point 3). */
export const BACKGROUND_SESSION_COLS = 120;
export const BACKGROUND_SESSION_ROWS = 40;

interface PtySessionRecord {
  id: string;
  process: pty.IPty;
  /** The directory the process was spawned in (its starting cwd). */
  cwd: string;
  dataDisposable: pty.IDisposable;
  exitDisposable: pty.IDisposable;
  /** Output routing; see `SessionIO`. */
  io: SessionIO;
  /** Set only for a task workspace's primary panel (see `PtySessionOptions.taskId`/`primary`, or a background launch's `taskId`). */
  taskId?: string;
  /** Whether a renderer is currently attached and receiving this session's output. Always `true` for a renderer-created session (`createSession`); `false` for a background-launched primary until `attachPrimarySession` rebinds it. */
  attached: boolean;
  /** Present only while `attached` is `false` for a background-launched primary (see `HeadlessHost`). Explicitly `undefined` once `attachPrimarySession` disposes it. */
  headless?: HeadlessHost | undefined;
  /** DEC private modes the program has set, tracked from spawn for the session's whole life (attached or not) — see `terminal-mode-tracker.ts`. Only present for a task primary. */
  modes?: TerminalModeTracker;
  /** Pending second half of an attach's repaint nudge (see `forceRepaint`). Cleared by any explicit resize or retirement. */
  repaintTimer?: ReturnType<typeof setTimeout> | undefined;
  /** OSC 7501 filter of a task primary (see `createProgramStatusFilter`); retiring it reports the exit. */
  statusFilter?: { dispose: () => void };
}

/**
 * Gap between the two resizes of a repaint nudge. Long enough that the
 * program renders the intermediate size first: pi-tui coalesces renders
 * (16ms minimum interval) and reads the size at render time, so two
 * back-to-back resizes collapse into one same-size, row-diffed frame.
 */
export const REPAINT_NUDGE_MS = 120;

const sessions = new Map<string, PtySessionRecord>();

/**
 * Where a task primary's OSC 7501 program status goes (decision #18: the
 * pty owner parses status and reports it to core; core never sees terminal
 * bytes). Wired once by main/index.ts to core's `reportPresence` /
 * `endPresence`.
 */
export interface ProgramStatusListener {
  onReport(taskId: string, pid: number, report: ProgramStatusReport): void;
  /** The task primary's process exited (pid liveness is the "ended" signal). */
  onExit(taskId: string, pid: number): void;
}

let programStatusListener: ProgramStatusListener | undefined;

export function setProgramStatusListener(
  listener: ProgramStatusListener | undefined,
): void {
  programStatusListener = listener;
}

/** How long a possibly-incomplete trailing 7501 sequence is held before it is passed through as-is. */
export const PROGRAM_STATUS_HOLD_MS = 100;

/**
 * Wraps a task primary's raw pty output: strips OSC 7501 reports (reported
 * to the listener), answers the feature-detection probe by writing the
 * reply into the pty, and forwards everything else to `forward`. A
 * sequence split across chunks is held back briefly (see
 * `PROGRAM_STATUS_HOLD_MS`) so it never reaches the terminal half-parsed.
 */
function createProgramStatusFilter(
  taskId: string,
  ptyProcess: pty.IPty,
  forward: (data: string) => void,
): { feed: (raw: string) => void; dispose: () => void } {
  const parser = new ProgramStatusParser();
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const clearHold = (): void => {
    if (holdTimer !== undefined) clearTimeout(holdTimer);
    holdTimer = undefined;
  };
  return {
    feed: (raw) => {
      clearHold();
      const result = parser.feed(raw);
      for (const reply of result.replies) {
        try {
          ptyProcess.write(reply);
        } catch {
          // Already gone; nothing to answer.
        }
      }
      for (const report of result.reports) {
        programStatusListener?.onReport(taskId, ptyProcess.pid, report);
      }
      if (result.output) forward(result.output);
      if (parser.hasPending) {
        holdTimer = setTimeout(() => {
          holdTimer = undefined;
          const held = parser.flush();
          if (held) forward(held);
        }, PROGRAM_STATUS_HOLD_MS);
      }
    },
    dispose: clearHold,
  };
}

/**
 * Pane-pid registry: taskId -> the id of its one primary pty session, if
 * any is currently live. A task has at most one primary pane, so this is
 * the app's own ground truth for "which pid, right now" that presence
 * corroboration (see `main/presence-corroboration.ts`) cross-checks the
 * extension's self-reported records against. An entry is removed the
 * instant its process exits (in the `onExit` subscription below, ahead of
 * the caller's own exit callback) or `disposeSession` runs — never left
 * pointing at a dead pid.
 */
const primaryTaskSessions = new Map<string, string>();

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "powershell.exe";
  }
  return process.env.SHELL ?? "/bin/bash";
}

/** The spec a harness adapter hands a frontend for its launch command (see `@harbormaster/core`'s `LaunchSpec`). Declared locally (structural) so callers need not import core's type. */
export interface LaunchSpecLike {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface PtySessionOptions {
  /** Spawn cwd override (e.g. a task's worktree path); defaults to the app's own cwd. */
  cwd?: string;
  /**
   * A harness launch spec to try first (e.g. a Pi pane). If its command
   * cannot be found on PATH, this session falls back to a plain `$SHELL` in
   * the same cwd and `fellBackToShell` is `true` in the result.
   */
  spec?: LaunchSpecLike;
  /**
   * The task this session belongs to, combined with `primary`. Registered
   * in the pane-pid registry (`lookupPanePid`) only when this session also
   * ends up actually running `spec` (a real harness launch, not a shell
   * fallback) - a "+ terminal" panel, a scratch task's shell, or a primary
   * pane that fell back to `$SHELL` because its harness command was
   * missing never has a presence record to corroborate against, and must
   * never be mistaken for one by showing a false "attached" badge.
   */
  taskId?: string;
  /** Whether this is the task's primary panel (see `taskId`). */
  primary?: boolean;
}

/**
 * Whether `command` resolves to an existing, executable file — a plain file
 * existence check (PATH lookup for bare names, direct check for paths),
 * not a spawn attempt. node-pty's `spawn` doesn't synchronously throw for a
 * missing binary (the fork succeeds; exec fails inside the child), so this
 * is checked up front instead of relying on a thrown error.
 */
export function commandExists(command: string): boolean {
  const candidates =
    command.includes("/") || command.startsWith("~")
      ? [command]
      : (process.env.PATH ?? "")
          .split(path.delimiter)
          .map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // Not on this PATH entry — keep looking.
    }
  }
  return false;
}

/**
 * Whether `path` is an existing directory. node-pty's `spawn` doesn't throw
 * synchronously for a missing cwd — the fork succeeds and the child dies
 * when it can't `chdir`, surfacing only as a bare `[process exited with
 * code 1]`. Callers probe up front (a task's worktree can be reaped out
 * from under a stale binding) so a dead cwd never silently kills a pane.
 */
export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function createSession(
  cols: number,
  rows: number,
  callbacks: PtySessionCallbacks,
  options?: PtySessionOptions,
): { id: string; pid: number; fellBackToShell: boolean } {
  const id = randomUUID();
  const cwd = options?.cwd || process.cwd();
  const spec = options?.spec;
  const useSpec = !!spec && commandExists(spec.command);
  const fellBackToShell = !!spec && !useSpec;

  // Defense in depth: never spawn into a directory that no longer exists
  // (node-pty would fork-then-exit-1 with no output). A stale worktree
  // binding is caught up front by `resolvePrimaryLaunch`, but any caller's
  // cwd could have been removed since; fall back to the app's own cwd.
  const requestedCwd = useSpec ? spec.cwd || cwd : cwd;
  const spawnCwd = directoryExists(requestedCwd) ? requestedCwd : process.cwd();
  const appVersion = safeAppVersion();
  const baseEnv = buildPtyEnv(process.env, useSpec ? spec.env : undefined, {
    appVersion,
    hyperlinks: true,
  });
  const ptyProcess = spawnWithFdHygiene(() =>
    useSpec
      ? pty.spawn(spec.command, spec.args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: spawnCwd,
          env: baseEnv,
        })
      : pty.spawn(defaultShell(), [], {
          name: "xterm-256color",
          cols,
          rows,
          cwd: spawnCwd,
          env: baseEnv,
        }),
  );

  // Subscriptions are owned by the session record so `disposeSession` can
  // unsubscribe them explicitly — killing the process alone doesn't
  // guarantee node-pty won't deliver one more queued onData/onExit event to
  // a callback that (if it forwarded straight to webContents.send) could
  // throw on an already-destroyed window.
  //
  // Output is coalesced per session (one `onData` per ~16ms flush, not per
  // OS read chunk) - see pty-data-batcher.ts for the measured why.
  // Flow control: every flush counts as outstanding until the renderer
  // acknowledges it (`acknowledgeSessionData`, after xterm parsed it); too
  // much outstanding pauses the pty, which just blocks the writer.
  const flow = createPtyFlowControl({
    pause: () => {
      try {
        ptyProcess.pause();
      } catch {
        // Already gone; nothing to throttle.
      }
    },
    resume: () => {
      try {
        ptyProcess.resume();
      } catch {
        // Already gone; nothing to resume.
      }
    },
  });
  const batcher = createPtyDataBatcher({
    send: (data) => {
      flow.sent(data.length);
      callbacks.onData(data);
    },
  });
  const io: SessionIO = {
    sink: (data) => batcher.push(data),
    exitSink: (exitCode) => callbacks.onExit(exitCode),
    flow,
    batcher,
  };
  // Only register a session that actually ran the harness spec (a real `pi`
  // launch, not a plain `$SHELL`) as the task's pane - a shell fallback
  // (missing `pi` binary) or a scratch task's bare terminal never gets a
  // presence record to corroborate against, and must never be mistaken for
  // one (a false "attached" badge on a task with no agent at all).
  const registerAsPane = useSpec && options?.primary && !!options?.taskId;
  // Only task primaries can later be detached/re-attached, so only they need
  // their modes tracked; plain shells skip the scan entirely.
  const modes = registerAsPane ? createTerminalModeTracker() : undefined;
  const forward = (data: string): void => {
    modes?.feed(data);
    io.sink(data);
  };
  // Only a task primary running the harness reports program status.
  const statusFilter =
    registerAsPane && options?.taskId
      ? createProgramStatusFilter(options.taskId, ptyProcess, forward)
      : undefined;
  const dataDisposable = ptyProcess.onData((data) => {
    if (statusFilter) statusFilter.feed(data);
    else forward(data);
  });
  const exitDisposable = ptyProcess.onExit(({ exitCode }) => {
    // Deliver every byte the process wrote before announcing its exit, so
    // the pane never prints "[process exited]" ahead of its last output.
    batcher.flush();
    // The OS process is confirmed dead the instant this fires (node-pty's
    // own exit event, independent of whether/when `disposeSession` is ever
    // called) — drop this session's pane-pid-registry entry right here, so
    // presence corroboration sees "no pane" immediately instead of however
    // long it takes the renderer to call `terminal.dispose()` (or the
    // window to close).
    const taskId = sessions.get(id)?.taskId;
    if (taskId && primaryTaskSessions.get(taskId) === id) {
      primaryTaskSessions.delete(taskId);
    }
    try {
      io.exitSink(exitCode);
    } finally {
      // A dead session is retired right here, not left for a dispose that
      // may never come (see `retireSession`).
      retireSession(id);
    }
  });

  sessions.set(id, {
    id,
    process: ptyProcess,
    cwd: spawnCwd,
    dataDisposable,
    exitDisposable,
    io,
    attached: true,
    ...(registerAsPane && modes ? { taskId: options.taskId, modes } : {}),
    ...(statusFilter ? { statusFilter } : {}),
  });
  if (registerAsPane && options?.taskId) {
    primaryTaskSessions.set(options.taskId, id);
  }
  return { id, pid: ptyProcess.pid, fellBackToShell };
}

function safeAppVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return "0.0.1";
  }
}

/**
 * Starts a task's primary pane in the background, with no renderer
 * attached (wave-2 task brief point 3): the background launcher's only way
 * to run a claimed launch. Spawns `spec` directly — never a shell fallback
 * (the caller, `primary-launch.ts`'s `resolvePrimaryLaunch`, already
 * verified the harness command exists; a background launch that can't run
 * it must be left alone with a `lastError`, never silently handed a plain
 * shell). Output feeds a `@xterm/headless` mirror (+ `addon-serialize`) so
 * a later `attachPrimarySession` can hand the attaching renderer a
 * snapshot of everything it missed; no flow control runs while unattached
 * (nobody will ever ack it) — the pty is never paused.
 *
 * Registered in the pane-pid registry exactly like an interactive primary
 * launch, so presence corroboration and `activeSessionPids`/
 * `activeSessionCwds` (protectedPaths) see it from the moment it starts,
 * not just once a renderer attaches.
 */
export function createBackgroundPrimarySession(
  taskId: string,
  spec: LaunchSpecLike,
  onExit: (exitCode: number) => void,
  options?: { cols?: number; rows?: number },
): { id: string; pid: number } {
  const id = randomUUID();
  const cols = options?.cols ?? BACKGROUND_SESSION_COLS;
  const rows = options?.rows ?? BACKGROUND_SESSION_ROWS;
  const env = buildPtyEnv(process.env, spec.env, {
    appVersion: safeAppVersion(),
    hyperlinks: true,
  });
  const ptyProcess = spawnWithFdHygiene(() =>
    pty.spawn(spec.command, spec.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: spec.cwd,
      env,
    }),
  );

  const headlessTerminal = new HeadlessTerminal({
    cols,
    rows,
    allowProposedApi: true,
  });
  const serialize = new SerializeAddon();
  headlessTerminal.loadAddon(serialize);

  const io: SessionIO = {
    sink: (data) => {
      try {
        headlessTerminal.write(data);
      } catch (error) {
        // A malformed/edge-case escape sequence must never crash the host
        // process over a paneless mirror nobody is looking at yet.
        console.error(
          `[ptySessions] background headless write failed for ${taskId}:`,
          error,
        );
      }
    },
    exitSink: () => {
      // No renderer attached yet: nothing further to notify beyond `onExit`
      // below (which fires regardless of attach state).
    },
  };
  const modes = createTerminalModeTracker();
  const statusFilter = createProgramStatusFilter(taskId, ptyProcess, (data) => {
    modes.feed(data);
    io.sink(data);
  });
  const dataDisposable = ptyProcess.onData((data) => statusFilter.feed(data));
  const exitDisposable = ptyProcess.onExit(({ exitCode }) => {
    // Attached by now (`attachPrimarySession`)? Deliver its last output
    // ahead of the exit, exactly like a renderer-created session.
    io.batcher?.flush();
    if (primaryTaskSessions.get(taskId) === id) {
      primaryTaskSessions.delete(taskId);
    }

    try {
      onExit(exitCode);
      io.exitSink(exitCode);
    } finally {
      // Retiring disposes the headless mirror (if still unattached), the
      // batcher (if attached) and the pty itself (see `retireSession`).
      retireSession(id);
    }
  });

  sessions.set(id, {
    id,
    process: ptyProcess,
    cwd: spec.cwd,
    dataDisposable,
    exitDisposable,
    io,
    attached: false,
    taskId,
    modes,
    headless: { terminal: headlessTerminal, serialize },
    statusFilter,
  });
  primaryTaskSessions.set(taskId, id);
  return { id, pid: ptyProcess.pid };
}

export interface AttachPrimaryResult {
  id: string;
  pid: number;
  /** The background session's current screen, serialized (scrollback + viewport + cursor position) — write this into the attaching renderer's xterm before switching to live streaming. */
  snapshot: string;
}

/**
 * Rebinds a task's live, currently-unattached background primary pty to a
 * requesting renderer (wave-2 task brief point 4): returns its serialized
 * screen (written into the renderer's xterm first) and its pid, resizes the
 * pty to the pane's actual size (Pi redraws on resize), and switches its
 * output to stream straight through `callbacks` with real flow control from
 * here on — exactly like a renderer-created session. Returns `undefined`
 * when there is no live background primary for `taskId` (never launched,
 * already exited, or already attached) — the caller falls back to
 * `pty:create` exactly as it would for a task with no background launch at
 * all.
 */
export function attachPrimarySession(
  taskId: string,
  cols: number,
  rows: number,
  callbacks: PtySessionCallbacks,
): AttachPrimaryResult | undefined {
  const sessionId = primaryTaskSessions.get(taskId);
  if (!sessionId) return undefined;
  const session = sessions.get(sessionId);
  if (!session || session.attached) return undefined;

  // addon-serialize restores alt screen, bracketed paste, focus reporting and
  // the mouse TRACKING mode, but omits mouse ENCODING (1005/1006/1015/1016)
  // and cursor visibility (?25). Without them the renderer's xterm would send
  // X10 mouse reports fullscreen pi can't parse (no wheel/selection) and show
  // a stray cursor. Append the tracked modes AFTER the serialized screen: the
  // serializer emits ?1049h plus the alt-buffer content, and a repeated
  // ?1049h on an already-alternate buffer leaves content and cursor intact.
  const serialized = session.headless?.serialize.serialize() ?? "";
  const snapshot = serialized + (session.modes?.replaySequence() ?? "");
  session.headless?.terminal.dispose();
  session.headless = undefined;

  const flow = createPtyFlowControl({
    pause: () => {
      try {
        session.process.pause();
      } catch {
        // Already gone; nothing to throttle.
      }
    },
    resume: () => {
      try {
        session.process.resume();
      } catch {
        // Already gone; nothing to resume.
      }
    },
  });
  const batcher = createPtyDataBatcher({
    send: (data) => {
      flow.sent(data.length);
      callbacks.onData(data);
    },
  });
  session.io.sink = (data) => batcher.push(data);
  session.io.exitSink = (exitCode) => callbacks.onExit(exitCode);
  session.io.flow = flow;
  session.io.batcher = batcher;
  session.attached = true;

  forceRepaint(session, cols, rows);

  return { id: session.id, pid: session.process.pid, snapshot };
}

/**
 * Resizes an attaching session's pty to the pane's size AND makes sure the
 * program repaints its whole screen. Fullscreen pi (pi-tui alt screen)
 * redraws only the rows it believes changed, and everything only on a size
 * change. The snapshot the pane just received can be blank or stale behind
 * pi's back (Cmd+K/Clear wiped xterm's buffer before the tab was closed; a
 * window reload's mirror never saw the screen), and re-attaching at the
 * pty's current size sends no SIGWINCH at all, so that pane stayed black
 * until pi happened to touch each row again. When the size is unchanged,
 * nudge it one row smaller and restore it a beat later: two real size
 * changes, each a full repaint.
 */
function forceRepaint(
  session: PtySessionRecord,
  cols: number,
  rows: number,
): void {
  clearRepaintTimer(session);
  const unchanged =
    session.process.cols === cols && session.process.rows === rows;
  try {
    session.process.resize(cols, unchanged && rows > 1 ? rows - 1 : rows);
  } catch {
    // The process can die between the registry lookup and here; its own
    // exit disposable (already wired at creation) reports that separately.
    return;
  }
  if (!unchanged || rows <= 1) return;
  session.repaintTimer = setTimeout(() => {
    session.repaintTimer = undefined;
    try {
      session.process.resize(cols, rows);
    } catch {
      // Exited in the meantime; nothing left to repaint.
    }
  }, REPAINT_NUDGE_MS);
}

function clearRepaintTimer(session: PtySessionRecord): void {
  if (session.repaintTimer === undefined) return;
  clearTimeout(session.repaintTimer);
  session.repaintTimer = undefined;
}

/**
 * The inverse of `attachPrimarySession`: hands a task's attached primary pty
 * back to the background (paneless, headless screen mirror, no flow
 * control) instead of killing it. Used when the renderer that owned it goes
 * away without disposing it — a window reload (dev full reload, Cmd+R) or a
 * renderer crash keeps the same webContents, so its panes never ran their
 * cleanup — so the reloaded pane's `attachPrimary` reconnects to the SAME
 * pi process instead of spawning a second one on the same session file.
 * Also used for an explicit tab close (`pty:release`), where the closing
 * pane passes `screen`: its serialized last screen, seeded into the mirror
 * so a reopen shows it immediately (the mirror otherwise starts empty, and
 * an idle pi only redraws on a size change). A reload has no such snapshot.
 * Returns `false` for anything that is not a task's registered primary (a
 * "+ terminal" shell, a shell fallback): the caller disposes those.
 */
export function detachPrimarySession(id: string, screen?: string): boolean {
  const session = sessions.get(id);
  if (!session?.taskId || primaryTaskSessions.get(session.taskId) !== id) {
    return false;
  }
  if (!session.attached) return true;

  session.io.batcher?.dispose();
  delete session.io.batcher;
  delete session.io.flow;
  // Flow control may have paused the pty waiting on acks that will never
  // come from the departed renderer; a background session is never paused.
  try {
    session.process.resume();
  } catch {
    // Already gone; its exit disposable reports that separately.
  }

  const headlessTerminal = new HeadlessTerminal({
    cols: session.process.cols || BACKGROUND_SESSION_COLS,
    rows: session.process.rows || BACKGROUND_SESSION_ROWS,
    allowProposedApi: true,
  });
  const serialize = new SerializeAddon();
  headlessTerminal.loadAddon(serialize);
  // This mirror starts mid-stream: it never saw pi's startup sequences, so
  // without this a later snapshot would lack alt screen and mouse modes.
  const replay = session.modes?.replaySequence();
  if (replay) headlessTerminal.write(replay);
  // Writes are applied in order, so this lands before any later live output.
  if (screen) headlessTerminal.write(screen);
  const taskId = session.taskId;
  session.io.sink = (data) => {
    try {
      headlessTerminal.write(data);
    } catch (error) {
      console.error(
        `[ptySessions] detached headless write failed for ${taskId}:`,
        error,
      );
    }
  };
  session.io.exitSink = () => {
    // Nothing to notify: the exit handler retires the session (disposing
    // this headless mirror) right after.
  };
  session.headless = { terminal: headlessTerminal, serialize };
  session.attached = false;
  return true;
}

/**
 * The last `count` lines of a task primary's screen while it runs paneless
 * (its headless mirror), for the inbox detail pane; `undefined` when the
 * task has no paneless primary (a mounted pane answers in the renderer).
 */
export function primarySessionTail(
  taskId: string,
  count: number,
): string | undefined {
  const sessionId = primaryTaskSessions.get(taskId);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session?.headless) return undefined;
  return bufferTail(session.headless.terminal.buffer.active, count);
}

export function getSession(id: string): PtySessionRecord | undefined {
  return sessions.get(id);
}

export function writeToSession(id: string, data: string): void {
  sessions.get(id)?.process.write(data);
}

/**
 * The renderer finished processing `chars` of this session's output (xterm's
 * write callback). Resumes a pty paused by flow control once the backlog
 * drains. Unknown/disposed ids are ignored.
 */
export function acknowledgeSessionData(id: string, chars: number): void {
  sessions.get(id)?.io.flow?.acknowledged(chars);
}

export function resizeSession(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) return;
  // The pane's own size wins over a pending repaint-nudge restore.
  clearRepaintTimer(session);
  try {
    session.process.resize(cols, rows);
  } catch {
    // The underlying process can die out from under this entry (a crash, an
    // OOM kill, an external `kill -9`, ...) before the renderer's own exit
    // handler or `disposeSession` ever runs - node-pty's resize ioctl
    // throws on an already-gone fd (EBADF) in that window. Same "already
    // gone, nothing left to do" guard as `disposeSession`'s own kill().
  }
}

export function disposeSession(id: string): void {
  retireSession(id);
}

/**
 * Drops a session record and releases everything it holds: subscriptions,
 * batcher timer, headless mirror, and the pty itself (master fd closed via
 * node-pty's `destroy()`, see `releasePty`). Runs from `disposeSession` and
 * from the process's own exit — a background pi nobody ever opened, or a
 * pane whose process exited before a reload, never gets a dispose call, and
 * a dead record left behind would keep its cwd in `activeSessionCwds()`
 * (blocking that worktree's cleanup until restart) and its pid in
 * `activeSessionPids()`. Idempotent: a second call (or a later
 * write/resize/dispose on the id) finds nothing and is a no-op.
 */
function retireSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  // Remove from the map first: disposing/killing can synchronously trigger
  // another onExit delivery, and we don't want a re-entrant disposeSession
  // call to find (and double-dispose) the same record.
  sessions.delete(id);
  if (session.taskId && primaryTaskSessions.get(session.taskId) === id) {
    primaryTaskSessions.delete(session.taskId);
  }
  clearRepaintTimer(session);
  session.dataDisposable.dispose();
  session.exitDisposable.dispose();
  if (session.statusFilter && session.taskId) {
    // Exited or disposed: either way the agent process is gone.
    session.statusFilter.dispose();
    programStatusListener?.onExit(session.taskId, session.process.pid);
  }
  // The renderer asked for (or is gone with) this pane: pending output has
  // nowhere to go, and a late timer flush must not outlive the session.
  session.io.batcher?.dispose();
  session.headless?.terminal.dispose();
  session.headless = undefined;
  releasePty(session.process);
}

export function disposeAllSessions(): void {
  for (const id of [...sessions.keys()]) {
    disposeSession(id);
  }
}

/**
 * Pids this process itself spawned, right now. Used by the takeover guard
 * (see main/index.ts) to tell "live in one of our own panes" apart from
 * "live somewhere else" without the renderer ever touching a pid directly.
 */
export function activeSessionPids(): Set<number> {
  return new Set(
    [...sessions.values()]
      .map((session) => session.process.pid)
      .filter((pid): pid is number => typeof pid === "number"),
  );
}

/**
 * Spawn cwds of every live pty right now, passed to core's `toDone` as
 * `protectedPaths` so a worktree is never removed out from under an open
 * pane. (Spawn cwd, not the shell's current cwd — a pane that `cd`s
 * elsewhere still protects the directory it was opened in.)
 */
export function activeSessionCwds(): string[] {
  return [...new Set([...sessions.values()].map((session) => session.cwd))];
}

export function hostShellLabel(): string {
  return `${defaultShell()} (${os.hostname()})`;
}

/**
 * The app's own ground truth for a task's primary pane right now: its real
 * child pid, if a primary session for `taskId` is currently live.
 * `undefined` when the task has no open primary pane (never launched,
 * closed, or its process already exited). Presence corroboration (see
 * `main/presence-corroboration.ts`) treats that as "no pane" and falls back
 * to trusting the extension's record exactly as the harness does today
 * (external sessions: ssh, a bare terminal, an adopted session).
 */
export function lookupPanePid(
  taskId: string,
): { pid: number; alive: boolean } | undefined {
  const sessionId = primaryTaskSessions.get(taskId);
  if (!sessionId) return undefined;
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  const pid = session.process.pid;
  if (typeof pid !== "number") return undefined;
  return { pid, alive: true };
}
