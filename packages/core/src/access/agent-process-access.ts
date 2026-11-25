// Resource Access: agents running on this machine outside Harbormaster's
// ptys (docs/import.md F3, F6). `ps` for the process table, ONE batched
// `lsof -a -d cwd -p <pids> -Fpn` for their folders, and Claude Code's own
// registry (`<claude config>/sessions/<pid>.json`) for the exact session of
// each Claude process. The parsing is pure and unit-tested on recorded
// output (tests/fixtures/import/processes/); only `listRunningAgents` does
// I/O, through an injectable runner.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ImportProcessAccess,
  RunningAgentProcess,
} from "../contracts/import.js";
import { runOutcome } from "../utilities/run.js";
import {
  type ImportReaderOptions,
  readerEnv,
  readerHome,
} from "./import-reader-common.js";

/** One `ps -axo pid=,lstart=,comm=,args=` line. */
export interface PsRow {
  pid: number;
  /** Process start, epoch ms (`lstart` is local time). */
  startedAtMs: number;
  /** `comm` and `args` of the line, whitespace-split (`comm` is cut at 16 characters by the OS). */
  tokens: string[];
}

const PS_LINE =
  /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/;

/** Parse `ps -axo pid=,lstart=,comm=,args=` output; unparseable lines are skipped. */
export function parsePs(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    const startedAtMs = Date.parse((match[2] as string).replace(/\s+/g, " "));
    rows.push({
      pid: Number(match[1]),
      startedAtMs: Number.isNaN(startedAtMs) ? 0 : startedAtMs,
      tokens: (match[3] as string).trim().split(/\s+/),
    });
  }
  return rows;
}

const basename = (path: string | undefined): string =>
  (path ?? "").split("/").at(-1) ?? "";

/**
 * Which harness an interactive agent process belongs to (docs/import.md F6),
 * or `undefined`. `tokens` = `comm` then the argument vector:
 * - Pi rewrites its process title: `comm` is `pi`.
 * - Claude Code: the executable is named `claude` (a bare `claude` or an
 *   installed path such as `~/.local/bin/claude`).
 * - Codex: the vendor binary `…/bin/codex`, never `codex app-server` (the
 *   desktop/IDE daemon) or the other non-interactive subcommands.
 * - Cursor: the `agent` launcher running `cursor-agent/versions/<v>/index.js`,
 *   never its `worker-server` child.
 */
export function classifyAgentProcess(
  tokens: readonly string[],
): string | undefined {
  const [comm, argv0, ...rest] = tokens;
  const args = [argv0, ...rest].filter((value): value is string => !!value);
  if (comm === "pi" && (!argv0 || basename(argv0) === "pi")) return "pi";
  if (basename(argv0 ?? comm) === "claude") return "claude-code";
  if (
    basename(argv0) === "codex" &&
    !args.some((arg) => arg === "app-server" || arg === "mcp-server") &&
    !["exec", "login", "logout", "mcp", "proto"].includes(
      args.slice(1).find((arg) => !arg.startsWith("-")) ?? "",
    )
  ) {
    return "codex";
  }
  if (
    args.some((arg) => /cursor-agent\/versions\/[^/]+\/index\.js$/.test(arg)) &&
    !args.includes("worker-server")
  ) {
    return "cursor";
  }
  return undefined;
}

/** Parse `lsof -a -d cwd -p … -Fpn` output (`p<pid>` then `fcwd` then `n<path>`) into pid → cwd. */
export function parseLsofCwds(text: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined && !cwds.has(pid)) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

/** One `<claude config>/sessions/<pid>.json`. */
export interface ClaudeRegistryEntry {
  pid: number;
  sessionId: string;
  cwd?: string;
  /** Epoch ms the process started (the file's `startedAt`). */
  startedAt: number;
}

/**
 * How far apart a registry file's `startedAt` and the live process's start
 * may be and still be the same process (the file is written a moment after
 * the process starts; a recycled pid starts far later). `procStart` in the
 * file is the same instant in UTC, whereas `ps` prints local time, so the
 * epoch `startedAt` is what is compared.
 */
export const REGISTRY_START_TOLERANCE_MS = 60_000;

/**
 * Combine a process table with the cwds and Claude's registry into the
 * running agents. A Claude registry entry counts only while its pid is a
 * live Claude process started when the file says (a crashed process leaves
 * a stale file); such a process carries its exact `sessionId`, every other
 * agent is folder-level.
 */
export function buildRunningAgents(
  rows: readonly PsRow[],
  cwds: ReadonlyMap<number, string>,
  registry: readonly ClaudeRegistryEntry[],
): RunningAgentProcess[] {
  const byPid = new Map(registry.map((entry) => [entry.pid, entry]));
  const agents: RunningAgentProcess[] = [];
  for (const row of rows) {
    const harness = classifyAgentProcess(row.tokens);
    if (!harness) continue;
    const entry = harness === "claude-code" ? byPid.get(row.pid) : undefined;
    const fresh =
      entry !== undefined &&
      Math.abs(entry.startedAt - row.startedAtMs) <=
        REGISTRY_START_TOLERANCE_MS;
    const cwd = cwds.get(row.pid) ?? (fresh ? entry.cwd : undefined);
    if (!cwd) continue;
    agents.push({
      harness,
      pid: row.pid,
      cwd,
      ...(fresh ? { sessionId: entry.sessionId } : {}),
    });
  }
  return agents;
}

/** Parse one registry file's text. */
export function parseClaudeRegistryEntry(
  text: string,
): ClaudeRegistryEntry | undefined {
  try {
    const data = JSON.parse(text);
    if (
      typeof data?.pid === "number" &&
      typeof data.sessionId === "string" &&
      typeof data.startedAt === "number"
    ) {
      return {
        pid: data.pid,
        sessionId: data.sessionId,
        startedAt: data.startedAt,
        ...(typeof data.cwd === "string" ? { cwd: data.cwd } : {}),
      };
    }
  } catch {}
  return undefined;
}

/** Runs a command and returns its stdout (even from a nonzero exit: `lsof` exits 1 when a pid is gone). */
export type CommandOutput = (
  command: string,
  args: string[],
) => Promise<string>;

export interface AgentProcessAccessOptions extends ImportReaderOptions {
  /** Claude's config dir (default `$CLAUDE_CONFIG_DIR`, else `<home>/.claude`). */
  claudeConfigDir?: string;
  /** Overrides how `ps` / `lsof` run; tests inject recorded output. */
  output?: CommandOutput;
}

const defaultOutput: CommandOutput = async (command, args) =>
  (await runOutcome(command, args, { timeoutMs: 10_000 })).stdout;

export class AgentProcessAccess implements ImportProcessAccess {
  constructor(private readonly options: AgentProcessAccessOptions = {}) {}

  async listRunningAgents(): Promise<RunningAgentProcess[]> {
    const output = this.options.output ?? defaultOutput;
    const rows = parsePs(
      await output("ps", ["-axo", "pid=,lstart=,comm=,args="]),
    );
    const agents = rows.filter((row) => classifyAgentProcess(row.tokens));
    if (agents.length === 0) return [];
    // One batched lsof for every agent pid.
    const lsof = await output("lsof", [
      "-a",
      "-d",
      "cwd",
      "-p",
      agents.map((row) => row.pid).join(","),
      "-Fpn",
    ]);
    const registry = await this.claudeRegistry();
    return buildRunningAgents(agents, parseLsofCwds(lsof), registry);
  }

  private async claudeRegistry(): Promise<ClaudeRegistryEntry[]> {
    const env = readerEnv(this.options);
    const dir = join(
      this.options.claudeConfigDir ??
        env.CLAUDE_CONFIG_DIR ??
        join(readerHome(this.options), ".claude"),
      "sessions",
    );
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const entries: ClaudeRegistryEntry[] = [];
    for (const name of names) {
      try {
        const entry = parseClaudeRegistryEntry(
          await readFile(join(dir, name), "utf8"),
        );
        if (entry) entries.push(entry);
      } catch {}
    }
    return entries;
  }
}
