// Pure helpers behind the `[pty]` lines in `<userData>/logs/main.log` (see
// app-log.ts): one line per spawn, spawn failure, exit, and attach/detach/
// release/dispose event, for the whole task-pty lifecycle (ptySessions.ts,
// primary-launch.ts and background-launcher.ts's call sites in
// main/index.ts). Formatting only — the actual `console.log`/`console.error`
// calls happen at each call site (already teed to main.log by app-log.ts's
// `installConsoleTee`), so nothing here touches Electron or node-pty.
//
// Never logs prompt text, message bodies, env *values*, or full argv —
// only lengths, presence flags, and the few identifiers (task id, session
// id, command path) needed to diagnose "nothing happened".

/** Strips ANSI escape/control sequences (CSI, OSC, simple C1) from captured pty output before it is ever logged or kept in the ring buffer. */
export function stripAnsi(input: string): string {
  return (
    input
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal ESC/BEL bytes is the point of an ANSI stripper.
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "") // OSC ... BEL/ST
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal ESC bytes is the point of an ANSI stripper.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI sequences
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal ESC bytes is the point of an ANSI stripper.
      .replace(/\x1b[@-_]/g, "") // other simple escapes
  );
}

/** How many trailing output lines a ring buffer keeps per pty (for an early-exit diagnostic dump). */
export const RING_BUFFER_LINES = 40;
/** A single kept line is capped to this many characters. */
export const RING_BUFFER_MAX_LINE_LENGTH = 200;

/**
 * Longest unfinished escape sequence carried into the next chunk (an OSC
 * title or hyperlink split by the pty read); a longer one is stripped as
 * text would be, leaving a little junk in the tail rather than growing.
 */
const MAX_ESCAPE_CARRY = 4096;
/** An escape sequence cut off at the end of a chunk: lone ESC, OSC without its BEL/ST, CSI without its final byte. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal ESC/BEL bytes is the point.
const UNFINISHED_ESCAPE = /^\x1b(?:\][^\x07\x1b]*|\[[0-?]*[ -/]*)?$/;

/**
 * A small bounded, in-memory tail of a pty's recent output: ANSI-stripped,
 * split into non-empty lines, each capped in length, only the newest
 * `maxLines` kept. Never persisted — only read when a session exits within
 * its early-exit window (see `formatPtyExitLine`).
 *
 * Every chunk costs O(chunk): only new data is stripped (an escape sequence
 * split across chunks is carried, bounded), and the unterminated last line
 * is capped at `maxLineLength` as it grows. Pi's fullscreen UI never prints
 * a newline, so an uncapped partial line held everything a pane ever drew
 * and each chunk re-stripped all of it: tens of ms of main-thread work per
 * frame on a long-lived pane, which lagged every pane's IPC.
 */
export class OutputRingBuffer {
  private readonly lines: string[] = [];
  /** The unterminated last line, leading whitespace dropped, at most `maxLineLength` chars. */
  private partial = "";
  /** Non-blank text was dropped from `partial` (its line ends in "…"). */
  private partialOverflow = false;
  /** An escape sequence cut off at the end of the previous chunk. */
  private carry = "";

  constructor(
    private readonly maxLines: number = RING_BUFFER_LINES,
    private readonly maxLineLength: number = RING_BUFFER_MAX_LINE_LENGTH,
  ) {}

  push(chunk: string): void {
    let raw = this.carry + chunk;
    this.carry = "";
    const esc = raw.lastIndexOf("\x1b");
    if (
      esc !== -1 &&
      raw.length - esc <= MAX_ESCAPE_CARRY &&
      UNFINISHED_ESCAPE.test(raw.slice(esc))
    ) {
      this.carry = raw.slice(esc);
      raw = raw.slice(0, esc);
    }
    const parts = stripAnsi(raw).split(/\r?\n/);
    const last = parts.pop() ?? "";
    if (parts.length > 0) {
      this.appendPartial(parts[0] ?? "");
      this.flushPartial();
      for (let i = 1; i < parts.length; i++) this.addLine(parts[i] ?? "");
    }
    this.appendPartial(last);
  }

  private appendPartial(text: string): void {
    if (this.partialOverflow || !text) return;
    const next = this.partial ? this.partial + text : text.trimStart();
    if (next.length <= this.maxLineLength) {
      this.partial = next;
      return;
    }
    this.partial = next.slice(0, this.maxLineLength);
    if (next.slice(this.maxLineLength).trim()) this.partialOverflow = true;
  }

  private flushPartial(): void {
    if (this.partialOverflow) this.keep(`${this.partial}…`);
    else this.addLine(this.partial);
    this.partial = "";
    this.partialOverflow = false;
  }

  private addLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.keep(
      trimmed.length > this.maxLineLength
        ? `${trimmed.slice(0, this.maxLineLength)}…`
        : trimmed,
    );
  }

  private keep(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) this.lines.shift();
  }

  /** The kept lines, oldest first (the trailing partial line is never included — it has no terminator yet). */
  tail(): string[] {
    return [...this.lines];
  }
}

/**
 * Replaces the argv element right after a literal `--` separator with
 * `<prompt N chars>`: both harness adapters that take a first-message
 * argument (`piPromptArgs`, `claudePromptArgs`) emit exactly `["--",
 * prompt]`, so this one rule covers every harness without ever importing
 * core's adapters (or their prompt text) into logging.
 */
export function redactPromptArgs(argv: readonly string[]): string[] {
  const idx = argv.indexOf("--");
  if (idx === -1 || idx + 1 >= argv.length) return [...argv];
  const out = [...argv];
  out[idx + 1] = `<prompt ${argv[idx + 1]?.length ?? 0} chars>`;
  return out;
}

/** Presence-only flags for the env keys worth knowing about — never a value that could be a secret. */
export interface PtyEnvFlags {
  /** `HARBORMASTER_TASK_ID`'s value: a task id is not a secret, and is far more useful printed than hidden. */
  taskId: string | undefined;
  hasSessionId: boolean;
  hasMcpServer: boolean;
}

export function ptyEnvFlags(
  env: Readonly<Record<string, string | undefined>>,
): PtyEnvFlags {
  return {
    taskId: env.HARBORMASTER_TASK_ID,
    hasSessionId: Boolean(env.HARBORMASTER_SESSION_ID),
    hasMcpServer: Boolean(env.HARBORMASTER_MCP_SERVER),
  };
}

export type PtyKind = "primary" | "background" | "shell";

export interface PtySpawnLogInput {
  sessionId: string;
  taskId?: string | undefined;
  kind: PtyKind;
  harness?: string | undefined;
  cwd: string;
  command: string;
  /** Where `command` resolves on this PATH (`resolveCommandPath`), `null` when nowhere: the binary actually run. */
  resolvedCommand: string | null;
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
}

/** `[pty] spawn id=... task=... kind=... harness=... cwd=... command=... resolved=... argv=[...] env={...}` */
export function formatPtySpawnLine(input: PtySpawnLogInput): string {
  const fields = {
    id: input.sessionId,
    task: input.taskId ?? "-",
    kind: input.kind,
    harness: input.harness ?? "-",
    cwd: input.cwd,
    command: input.command,
    resolved: input.resolvedCommand,
    argv: redactPromptArgs(input.argv),
    env: ptyEnvFlags(input.env),
  };
  return `[pty] spawn ${JSON.stringify(fields)}`;
}

export interface PtySpawnFailureLogInput {
  sessionId: string;
  taskId?: string | undefined;
  kind: PtyKind;
  command: string;
  error: unknown;
}

/** `[pty] spawn-failed id=... task=... kind=... command=... error=...` */
export function formatPtySpawnFailureLine(
  input: PtySpawnFailureLogInput,
): string {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);
  return `[pty] spawn-failed ${JSON.stringify({
    id: input.sessionId,
    task: input.taskId ?? "-",
    kind: input.kind,
    command: input.command,
    error: message,
  })}`;
}

/** A session is a candidate for an early-exit output dump when it ran for less than this long. */
export const EARLY_EXIT_WINDOW_MS = 30_000;

export interface PtyExitLogInput {
  sessionId: string;
  taskId?: string | undefined;
  kind: PtyKind;
  exitCode: number;
  signal?: number | undefined;
  spawnedAtMs: number;
  exitedAtMs: number;
  /** Recent output tail (see `OutputRingBuffer.tail()`); included only for an early exit. */
  recentOutput?: readonly string[] | undefined;
  earlyExitWindowMs?: number | undefined;
}

/** `[pty] exit id=... task=... kind=... exitCode=... signal=... durationMs=...`, plus a `tail=[...]` for an early exit. */
export function formatPtyExitLine(input: PtyExitLogInput): string {
  const durationMs = Math.max(0, input.exitedAtMs - input.spawnedAtMs);
  const early = durationMs < (input.earlyExitWindowMs ?? EARLY_EXIT_WINDOW_MS);
  const fields: Record<string, unknown> = {
    id: input.sessionId,
    task: input.taskId ?? "-",
    kind: input.kind,
    exitCode: input.exitCode,
    signal: input.signal ?? null,
    durationMs,
  };
  if (early && input.recentOutput?.length) {
    fields.tail = input.recentOutput;
  }
  return `[pty] exit ${JSON.stringify(fields)}`;
}

export type PtyLifecycleEvent = "attach" | "detach" | "release" | "dispose";

/** `[pty] <event> id=... task=...` */
export function formatPtyLifecycleLine(
  event: PtyLifecycleEvent,
  sessionId: string,
  taskId?: string,
): string {
  return `[pty] ${event} ${JSON.stringify({ id: sessionId, task: taskId ?? "-" })}`;
}
