// Runtime evidence Export diagnostics adds on top of logs and state, all
// collected only when the user exports:
//
// - `agents-ps.json`: CPU %, memory, uptime and CPU time of each live
//   agent process. One `ps -o … -p <our agent pids>`: never `ps -ax`, never
//   command lines (EDR agents treat broad process listing as recon; the
//   pids are the ones presence already knows). `/bin/ps` with a short argv
//   is also clear of the interpreter + long-argument kill seen on a
//   SentinelOne Mac.
// - `session-files.json`: each open task's agent session file: size,
//   last-modified time and entry count (newlines streamed, never parsed,
//   within a byte and time budget).
// - `renderer.json`: the renderer's long frames and what was focused
//   (renderer lib/renderer-diagnostics.ts), read through
//   `executeJavaScript`.
// - `profiles/*.cpuprofile`: the saved main-process profiles
//   (cpu-profile.ts), newest first, within a total byte cap.
//
// Every collector is best effort: a failure becomes an `error` field, never
// a failed export.
import { execFile } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { listProfiles } from "./cpu-profile";
import type { DiagnosticsState } from "./diagnostics";

/** A live agent process, as presence knows it. */
export interface AgentProcess {
  taskId: string;
  harness?: string;
  pid: number;
  sessionPath?: string;
}

/** One task's session file to measure. */
export interface SessionFileRef {
  taskId: string;
  path: string;
  live: boolean;
}

/** Live agents and the session files of open tasks, from `state/` (core commands only). */
export function runtimeTargets(state: DiagnosticsState | undefined): {
  agents: AgentProcess[];
  sessionFiles: SessionFileRef[];
} {
  const agents: AgentProcess[] = [];
  const sessionFiles: SessionFileRef[] = [];
  const seen = new Set<string>();
  for (const entry of state?.tasks ?? []) {
    const taskId = String(entry.task.id ?? "");
    const taskState = entry.task.state;
    const presence = entry.presence as
      | { live?: boolean; record?: { pid?: number; sessionPath?: string } }
      | undefined;
    const live = presence?.live === true;
    const record = presence?.record;
    if (live && typeof record?.pid === "number" && record.pid > 0) {
      agents.push({
        taskId,
        ...(typeof entry.task.harness === "string"
          ? { harness: entry.task.harness }
          : {}),
        pid: record.pid,
        ...(record.sessionPath ? { sessionPath: record.sessionPath } : {}),
      });
    }
    const open = taskState === "working" || taskState === "awaiting";
    const path =
      (live ? record?.sessionPath : undefined) ??
      (typeof entry.binding?.sessionPath === "string"
        ? entry.binding.sessionPath
        : undefined);
    if ((live || open) && path && !seen.has(path)) {
      seen.add(path);
      sessionFiles.push({ taskId, path, live });
    }
  }
  return { agents, sessionFiles };
}

export interface AgentProcessStats extends AgentProcess {
  ppid?: number;
  cpuPercent?: number;
  rssMb?: number;
  /** `ps` etime, e.g. "1-02:03:04" (uptime). */
  elapsed?: string;
  /** `ps` time: total CPU time used. */
  cpuTime?: string;
  /** Not in `ps` output (exited since presence last saw it). */
  gone?: true;
}

export type CommandRunner = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<string>;

const runCommand: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout) => {
      // `ps -p` exits 1 when one of the pids is gone but still prints the rest.
      if (error && !stdout) reject(error);
      else resolve(String(stdout));
    });
  });

/** `ps` columns asked for, in order. */
const PS_FIELDS = "pid=,ppid=,pcpu=,rss=,etime=,time=";

/** Parses `ps -o pid=,ppid=,pcpu=,rss=,etime=,time=` output. */
export function parsePsOutput(
  stdout: string,
): Map<number, Omit<AgentProcessStats, keyof AgentProcess>> {
  const out = new Map<number, Omit<AgentProcessStats, keyof AgentProcess>>();
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [pid, ppid, pcpu, rss, elapsed, cpuTime] = parts;
    const pidNumber = Number(pid);
    if (!Number.isInteger(pidNumber)) continue;
    out.set(pidNumber, {
      ppid: Number(ppid),
      cpuPercent: Number(pcpu),
      rssMb: Math.round(Number(rss) / 1024),
      ...(elapsed ? { elapsed } : {}),
      ...(cpuTime ? { cpuTime } : {}),
    });
  }
  return out;
}

/** One narrow `ps` for our agents' pids (nothing to run for none). */
export async function agentProcessStats(
  agents: readonly AgentProcess[],
  run: CommandRunner = runCommand,
): Promise<{ agents: AgentProcessStats[]; error?: string }> {
  if (agents.length === 0) return { agents: [] };
  const pids = [...new Set(agents.map((agent) => agent.pid))];
  try {
    const stats = parsePsOutput(
      await run("/bin/ps", ["-o", PS_FIELDS, "-p", pids.join(",")], 3_000),
    );
    return {
      agents: agents.map((agent) => {
        const found = stats.get(agent.pid);
        return found ? { ...agent, ...found } : { ...agent, gone: true };
      }),
    };
  } catch (error) {
    return {
      agents: [...agents],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface SessionFileStats extends SessionFileRef {
  bytes?: number;
  modifiedAt?: string;
  /** Newline count (one JSONL entry per line). */
  entries?: number;
  /** Why `entries` is missing ("over 200 MB", "time budget", …). */
  notCounted?: string;
  error?: string;
}

export const SESSION_COUNT_MAX_BYTES = 200 * 1024 * 1024;
export const SESSION_COUNT_BUDGET_MS = 2_000;

/** Counts newlines by streaming, giving up after `budgetMs`. */
function countLines(
  path: string,
  budgetMs: number,
  now: () => number,
): Promise<number | "budget"> {
  return new Promise((resolve, reject) => {
    const started = now();
    let lines = 0;
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      let at = buffer.indexOf(10);
      while (at !== -1) {
        lines += 1;
        at = buffer.indexOf(10, at + 1);
      }
      if (now() - started > budgetMs) {
        stream.destroy();
        resolve("budget");
      }
    });
    stream.on("end", () => resolve(lines));
    stream.on("error", reject);
  });
}

/** Size, mtime and (within budget) entry count of each session file. */
export async function sessionFileStats(
  files: readonly SessionFileRef[],
  options: {
    maxCountBytes?: number;
    budgetMs?: number;
    now?: () => number;
  } = {},
): Promise<SessionFileStats[]> {
  const maxCountBytes = options.maxCountBytes ?? SESSION_COUNT_MAX_BYTES;
  const budgetMs = options.budgetMs ?? SESSION_COUNT_BUDGET_MS;
  const now = options.now ?? Date.now;
  const out: SessionFileStats[] = [];
  for (const file of files) {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(file.path);
    } catch (error) {
      out.push({
        ...file,
        error:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : String(error),
      });
      continue;
    }
    const base: SessionFileStats = {
      ...file,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
    if (stat.size > maxCountBytes) {
      out.push({
        ...base,
        notCounted: `over ${Math.round(maxCountBytes / 1024 / 1024)} MB`,
      });
      continue;
    }
    try {
      const counted = await countLines(file.path, budgetMs, now);
      out.push(
        counted === "budget"
          ? { ...base, notCounted: `over the ${budgetMs} ms budget` }
          : { ...base, entries: counted },
      );
    } catch (error) {
      out.push({ ...base, error: String(error) });
    }
  }
  return out;
}

/** The saved CPU profiles for the bundle, newest first, within `capBytes` in total. */
export function profilesForBundle(
  dir: string,
  capBytes: number,
): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  let used = 0;
  for (const profile of listProfiles(dir)) {
    if (used + profile.bytes > capBytes) continue;
    try {
      const text = readFileSync(profile.path, "utf8");
      out.push({ name: profile.name, text });
      used += profile.bytes;
    } catch {
      // Pruned meanwhile.
    }
  }
  return out;
}

/** Reads the renderer's diagnostics hook; `undefined` when it does not answer in time. */
export async function rendererDiagnostics(
  run: (code: string) => Promise<unknown>,
  timeoutMs = 1_500,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(
        "window.__harbormasterDiagnostics ? window.__harbormasterDiagnostics() : null",
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
