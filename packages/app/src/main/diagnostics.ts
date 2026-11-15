// "Export diagnostics" (release plan R17: no telemetry, a user-initiated zip
// instead). Collects `<userData>/logs`, a redacted copy of the state dir's
// config.json, the app / Electron / Node versions and (best effort) the
// `harbormaster rules list` output into one archive the user can attach to
// a bug report. Everything here is a read-only copy; nothing is uploaded.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { BoardColumn, WorkspaceBinding } from "@harbormaster/core";
import { createZip, type ZipEntry } from "./zip-writer";

export const REDACTED = "[redacted]";

/** Keys whose value is a secret whatever it looks like. */
const SECRET_KEY =
  /(token|secret|passw(or)?d|pwd|api[-_]?key|apikey|auth|credential|cookie|private[-_]?key|session[-_]?key|bearer)/i;

/** Known token shapes (GitHub, OpenAI/Anthropic-style keys, Slack, JWT). */
const SECRET_VALUE =
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

/** Query parameters that commonly carry credentials. */
const SECRET_QUERY =
  /([?&](?:access_token|token|key|api_key|apikey|auth|sig|signature|password|secret|code)=)[^&#\s]*/gi;

/**
 * Redacts one string: credentials embedded in URLs (`https://user:pass@`,
 * `?token=…`) and anything shaped like a known token.
 */
export function redactString(value: string): string {
  return value
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi,
      `$1${REDACTED}@`,
    )
    .replace(SECRET_QUERY, `$1${REDACTED}`)
    .replace(SECRET_VALUE, REDACTED);
}

/**
 * A deep copy of a parsed config with every secret-named key's value
 * replaced by `[redacted]` and every remaining string run through
 * `redactString`. Non-secret structure (repositories, launch settings,
 * deployment stage names) stays readable for debugging.
 */
export function redactConfig(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY.test(key) && value !== null) {
    return typeof value === "boolean" ? value : REDACTED;
  }
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactConfig(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) {
      out[childKey] = redactConfig(child, childKey);
    }
    return out;
  }
  return value;
}

/** config.json, redacted; a missing or unparsable file is described, never thrown. */
export function redactedConfigText(configFile: string): string {
  let raw: string;
  try {
    raw = readFileSync(configFile, "utf8");
  } catch {
    return `// ${configFile} does not exist\n`;
  }
  try {
    return `${JSON.stringify(redactConfig(JSON.parse(raw)), null, 2)}\n`;
  } catch {
    // Not JSON: still ship it, string-redacted, since a broken config is
    // exactly the kind of thing a diagnostics bundle should show.
    return redactString(raw);
  }
}

/** Per-file cap: a runaway log keeps only its newest bytes. */
export const MAX_LOG_FILE_BYTES = 20 * 1024 * 1024;

/** Every regular file under `logsDir` as `logs/<relative path>` entries. */
export function collectLogEntries(
  logsDir: string,
  maxBytes = MAX_LOG_FILE_BYTES,
): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stats.isFile()) continue;
      try {
        let data = readFileSync(path);
        if (data.length > maxBytes) data = data.subarray(-maxBytes);
        entries.push({
          name: `logs/${relative(logsDir, path).split(sep).join("/")}`,
          data,
          mtime: stats.mtime,
        });
      } catch {
        // Unreadable file: skip it rather than fail the whole export.
      }
    }
  };
  walk(logsDir);
  return entries;
}

export interface DiagnosticsInput {
  logsDir: string;
  configFile: string;
  /** Free-form environment facts (app / electron / node versions, ...). */
  versions: Record<string, string | boolean | undefined>;
  /** `harbormaster rules list` output, or why it is missing. */
  rulesList?: string;
  /** `tasks-summary.json`'s content (see `buildTasksSummary`), already built through the core command API — this module never reads state files directly. */
  tasksSummary?: TaskSummaryEntry[];
  /** `environment.json`'s content (see `buildEnvironmentInfo`). */
  environment?: EnvironmentInfo;
  now?: Date;
}

/** The diagnostics archive as a ZIP buffer. */
export function buildDiagnosticsZip(input: DiagnosticsInput): Buffer {
  const now = input.now ?? new Date();
  const entries: ZipEntry[] = [
    {
      name: "versions.json",
      data: `${JSON.stringify({ exportedAt: now.toISOString(), ...input.versions }, null, 2)}\n`,
      mtime: now,
    },
    {
      name: "config.redacted.json",
      data: redactedConfigText(input.configFile),
      mtime: now,
    },
    ...collectLogEntries(input.logsDir),
  ];
  if (input.rulesList !== undefined) {
    entries.push({
      name: "rules-list.txt",
      data: redactString(input.rulesList),
      mtime: now,
    });
  }
  if (input.tasksSummary !== undefined) {
    entries.push({
      name: "tasks-summary.json",
      data: `${JSON.stringify(input.tasksSummary, null, 2)}\n`,
      mtime: now,
    });
  }
  if (input.environment !== undefined) {
    entries.push({
      name: "environment.json",
      data: `${JSON.stringify(input.environment, null, 2)}\n`,
      mtime: now,
    });
  }
  return createZip(entries);
}

/** The slice of `CoreCommands` `buildTasksSummary` needs — structural so callers (including tests) can pass a minimal fake; never anything that reads a state file directly. */
export interface TasksSummaryCommands {
  listBoard(): Promise<BoardColumn[]>;
  getTaskWorkspace(taskId: string): Promise<WorkspaceBinding | undefined>;
}

export interface TaskSummaryBinding {
  worktreePath?: string;
  scratch?: boolean;
  inPlace?: boolean;
  sessionId?: string;
  hasSessionPath: boolean;
}

export interface TaskSummaryEntry {
  id: string;
  kind: string;
  state: string;
  /** Titles are fine in a diagnostics bundle — only prompts/message bodies are excluded. */
  title: string;
  harness?: string;
  model?: string;
  sessionModel?: string;
  launch?: { status: string; requestedAt: string; startedAt?: string };
  parentTaskId?: string;
  hasPr: boolean;
  initialPromptDeliveredAt?: string;
  binding?: TaskSummaryBinding;
}

/**
 * `tasks-summary.json`: one entry per task, built entirely through
 * `listBoard`/`getTaskWorkspace` (the core command API) — never a direct
 * state-file read. Deliberately excludes `initialPrompt` and anything else
 * that could carry message text; `title` is the one free-text field kept
 * (titles, unlike prompts, are expected to be short and non-sensitive).
 */
export async function buildTasksSummary(
  commands: TasksSummaryCommands,
): Promise<TaskSummaryEntry[]> {
  const columns = await commands.listBoard();
  const tasks = columns.flatMap((column) =>
    column.groups.flatMap((group) => group.tasks),
  );
  return Promise.all(
    tasks.map(async (task) => {
      const binding = await commands
        .getTaskWorkspace(task.id)
        .catch(() => undefined);
      const entry: TaskSummaryEntry = {
        id: task.id,
        kind: task.kind,
        state: task.state,
        title: task.title,
        hasPr: Boolean(task.pr),
        ...(task.harness ? { harness: task.harness } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.sessionModel ? { sessionModel: task.sessionModel } : {}),
        ...(task.launch
          ? {
              launch: {
                status: task.launch.status,
                requestedAt: task.launch.requestedAt,
                ...(task.launch.startedAt
                  ? { startedAt: task.launch.startedAt }
                  : {}),
              },
            }
          : {}),
        ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
        ...(task.initialPromptDeliveredAt
          ? { initialPromptDeliveredAt: task.initialPromptDeliveredAt }
          : {}),
        ...(binding
          ? {
              binding: {
                ...(binding.worktreePath
                  ? { worktreePath: binding.worktreePath }
                  : {}),
                ...(binding.scratch ? { scratch: true } : {}),
                ...(binding.inPlace ? { inPlace: true } : {}),
                ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
                hasSessionPath: Boolean(binding.sessionPath),
              },
            }
          : {}),
      };
      return entry;
    }),
  );
}

export interface ExtensionFileInfo {
  name: string;
  mtime: string;
  size: number;
}

/** `{ name, mtime, size }` for the installed Pi inbox extension file, or `undefined` when it doesn't exist — never its content (that's source code, not a secret, but irrelevant to diagnostics). */
export function extensionFileInfo(path: string): ExtensionFileInfo | undefined {
  try {
    const stats = statSync(path);
    return {
      name: path.split(sep).pop() ?? path,
      mtime: stats.mtime.toISOString(),
      size: stats.size,
    };
  } catch {
    return undefined;
  }
}

export interface EnvironmentInfo {
  app: string;
  electron: string;
  node: string;
  platform: string;
  arch: string;
  path: string;
  shell?: string;
  pi: { resolved?: string; version?: string };
  claude: { resolved?: string; version?: string };
  piExtension?: ExtensionFileInfo;
}

export interface BuildEnvironmentInfoInput {
  app: string;
  electron: string;
  node: string;
  platform: string;
  path: string;
  shell?: string;
  pi: { resolved?: string; version?: string };
  claude: { resolved?: string; version?: string };
  /** Path to the installed Pi inbox extension file (see agent-tooling.ts's `piExtensionsDir`/`PI_EXTENSION_FILE`); only its stat (name/mtime/size) is read. */
  piExtensionPath?: string;
}

/** `environment.json`'s content: versions, PATH, resolved agent commands and their `--version` output (best effort), and the installed Pi extension's stat. */
export function buildEnvironmentInfo(
  input: BuildEnvironmentInfoInput,
): EnvironmentInfo {
  const piExtension = input.piExtensionPath
    ? extensionFileInfo(input.piExtensionPath)
    : undefined;
  return {
    app: input.app,
    electron: input.electron,
    node: input.node,
    platform: input.platform,
    arch: process.arch,
    path: input.path,
    ...(input.shell ? { shell: input.shell } : {}),
    pi: input.pi,
    claude: input.claude,
    ...(piExtension ? { piExtension } : {}),
  };
}

/** Default file name offered in the save dialog. */
export function diagnosticsFileName(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[:T]/g, "-");
  return `harbormaster-diagnostics-${stamp}.zip`;
}
