// "Export diagnostics" (release plan R17: no telemetry, a user-initiated zip
// instead). Collects recent tails of `<userData>/logs` (see
// diagnostics-limits.ts), a redacted copy of the state dir's config.json,
// the app / Electron / Node versions, (best effort) the `harbormaster rules
// list` output and a `state/` snapshot built through core commands into one
// size-capped archive the user can attach to a bug report, with a
// `manifest.json` (random per-bundle id, file sizes, limits applied).
// Secrets are redacted and the home folder is shown as `~`. Everything here
// is a read-only copy; nothing is uploaded.
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, sep } from "node:path";
import type {
  BoardColumn,
  KnownLocation,
  PresenceStatus,
  RepositoryInfo,
  Task,
  TaskMessagingState,
  WorkspaceBinding,
} from "@harbormaster/core";
import {
  byteSize,
  capJson,
  capText,
  collectLogTail,
  DIAGNOSTICS_LIMITS,
  type DiagnosticsLimits,
  rotatedLogFiles,
} from "./diagnostics-limits";
import { profilesForBundle } from "./diagnostics-runtime";
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

/**
 * `text` with the user's home folder replaced by `~` (a path segment match:
 * `/Users/alice/x` → `~/x`, never `/Users/alicette`). Also matches the
 * JSON-escaped form (Windows backslashes). Pure and idempotent.
 */
export function replaceHomeDir(text: string, home: string): string {
  const trimmed = home.replace(/[\\/]+$/, "");
  // A root or one-letter "home" would mangle everything; leave text alone.
  if (trimmed.length < 2) return text;
  const variants = [
    ...new Set([trimmed, JSON.stringify(trimmed).slice(1, -1)]),
  ].sort((a, b) => b.length - a.length);
  let out = text;
  for (const variant of variants) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`${escaped}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`, "g"),
      "~",
    );
  }
  return out;
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
  /** `state/` (see `buildDiagnosticsState`), built through core commands. */
  state?: DiagnosticsState;
  /** `harbormaster doctor` result, written as `doctor.json`. */
  doctor?: unknown;
  /** Per-harness Plannotator status (`reviewSupport`: each piece, including the Claude `/plannotator-review` skill), written as `review-support.json`. */
  reviewSupport?: unknown;
  /** The crash sentinel's last unclean exit, recorded in `manifest.json`. */
  lastUncleanExit?: unknown;
  /** OS crash report names (never contents), written as `crash-reports.json`. */
  crashReports?: Array<{ name: string; mtime: string }>;
  /** Live ptys' lifetime totals (pty-traffic.ts), written as `ptys.json`. */
  ptys?: unknown;
  /** One narrow `ps` of the live agents (diagnostics-runtime.ts), written as `agents-ps.json`. */
  agentProcesses?: unknown;
  /** Open tasks' session files: size, mtime, entry count, written as `session-files.json`. */
  sessionFiles?: unknown;
  /** The renderer's long frames and focus (renderer-diagnostics.ts), written as `renderer.json`. */
  renderer?: unknown;
  /** Folder of saved main-process CPU profiles (cpu-profile.ts); the newest go in `profiles/` within `limits.profilesBytes`. */
  profilesDir?: string;
  /** Replace the home folder with `~` in every file (default `true`). */
  replaceHome?: boolean;
  /** Home folder to replace; defaults to `os.homedir()`. */
  homeDir?: string;
  limits?: Partial<DiagnosticsLimits>;
  now?: Date;
}

/** Per-file caps for the non-log files (logs get the budget that is left). */
const FILE_CAPS = {
  config: 256 * 1024,
  rulesList: 256 * 1024,
  tasksSummary: 512 * 1024,
  environment: 64 * 1024,
  doctor: 512 * 1024,
  reviewSupport: 64 * 1024,
  crashReports: 64 * 1024,
  ptys: 128 * 1024,
  agentProcesses: 64 * 1024,
  sessionFiles: 128 * 1024,
  renderer: 256 * 1024,
  stateTasks: 1024 * 1024,
  stateLocations: 128 * 1024,
  stateRepositories: 256 * 1024,
  stateMessaging: 128 * 1024,
} as const;

/** The log kinds with a reserved budget, in collection order. */
const RESERVED_LOGS: Array<{
  name: string;
  budget: keyof DiagnosticsLimits;
}> = [
  { name: "wake.log", budget: "wakeLogBytes" },
  { name: "main.log", budget: "mainLogBytes" },
];

export interface DiagnosticsManifestFile {
  name: string;
  bytes: number;
  truncated?: boolean;
}

export interface DiagnosticsLogReport {
  budgetBytes: number;
  files: string[];
  keptLines: number;
  droppedLines: number;
  truncated: boolean;
  truncatedBy?: "lookback" | "budget";
  oldestKept?: string;
  newestKept?: string;
}

export interface DiagnosticsManifest {
  schemaVersion: 1;
  /** Random per bundle (never a stable install id). */
  bundleId: string;
  exportedAt: string;
  appVersion?: string;
  homeReplaced: boolean;
  limits: DiagnosticsLimits;
  /** Every other file in the bundle with its uncompressed size. */
  files: DiagnosticsManifestFile[];
  totalBytes: number;
  logs: Record<string, DiagnosticsLogReport>;
  stateErrors?: Record<string, string>;
  lastUncleanExit?: unknown;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The diagnostics archive as a ZIP buffer. */
export function buildDiagnosticsZip(input: DiagnosticsInput): Buffer {
  const now = input.now ?? new Date();
  const limits: DiagnosticsLimits = { ...DIAGNOSTICS_LIMITS, ...input.limits };
  const homeReplaced = input.replaceHome ?? true;
  const home = input.homeDir ?? homedir();
  const scrub = (text: string): string =>
    homeReplaced ? replaceHomeDir(text, home) : text;

  const files: Array<{ name: string; data: string; truncated: boolean }> = [];
  let used = 0;
  const add = (
    name: string,
    capped: { text: string; truncated: boolean },
  ): void => {
    const data = scrub(capped.text);
    files.push({ name, data, truncated: capped.truncated });
    used += byteSize(data);
  };
  const addJson = (name: string, value: unknown, cap: number): void =>
    add(name, capJson(redactConfig(value), cap));

  add("versions.json", {
    text: json(
      redactConfig({ exportedAt: now.toISOString(), ...input.versions }),
    ),
    truncated: false,
  });
  add(
    "config.redacted.json",
    capText(redactedConfigText(input.configFile), FILE_CAPS.config),
  );
  if (input.rulesList !== undefined) {
    add(
      "rules-list.txt",
      capText(redactString(input.rulesList), FILE_CAPS.rulesList),
    );
  }
  if (input.tasksSummary !== undefined) {
    addJson("tasks-summary.json", input.tasksSummary, FILE_CAPS.tasksSummary);
  }
  if (input.environment !== undefined) {
    addJson("environment.json", input.environment, FILE_CAPS.environment);
  }
  if (input.doctor !== undefined) {
    addJson("doctor.json", input.doctor, FILE_CAPS.doctor);
  }
  if (input.reviewSupport !== undefined) {
    addJson(
      "review-support.json",
      input.reviewSupport,
      FILE_CAPS.reviewSupport,
    );
  }
  if (input.crashReports !== undefined) {
    addJson("crash-reports.json", input.crashReports, FILE_CAPS.crashReports);
  }
  if (input.ptys !== undefined) {
    addJson("ptys.json", input.ptys, FILE_CAPS.ptys);
  }
  if (input.agentProcesses !== undefined) {
    addJson("agents-ps.json", input.agentProcesses, FILE_CAPS.agentProcesses);
  }
  if (input.sessionFiles !== undefined) {
    addJson("session-files.json", input.sessionFiles, FILE_CAPS.sessionFiles);
  }
  if (input.renderer !== undefined) {
    addJson("renderer.json", input.renderer, FILE_CAPS.renderer);
  }
  // Profiles before the logs: the logs get whatever budget is left.
  if (input.profilesDir) {
    for (const profile of profilesForBundle(
      input.profilesDir,
      limits.profilesBytes,
    )) {
      add(`profiles/${profile.name}`, { text: profile.text, truncated: false });
    }
  }
  const state = input.state;
  if (state?.tasks) {
    addJson("state/tasks.json", state.tasks, FILE_CAPS.stateTasks);
  }
  if (state?.locations) {
    addJson("state/locations.json", state.locations, FILE_CAPS.stateLocations);
  }
  if (state?.repositories) {
    addJson(
      "state/repositories.json",
      state.repositories,
      FILE_CAPS.stateRepositories,
    );
  }
  if (state?.messaging) {
    addJson("state/messaging.json", state.messaging, FILE_CAPS.stateMessaging);
  }

  // Logs get what is left, reserved kinds first, never past the bundle cap.
  const logKinds = rotatedLogFiles(input.logsDir);
  const order = [
    ...RESERVED_LOGS.map((kind) => ({
      name: kind.name,
      budget: limits[kind.budget],
    })),
    ...[...logKinds.keys()]
      .filter((name) => !RESERVED_LOGS.some((kind) => kind.name === name))
      .map((name) => ({ name, budget: limits.otherLogBytes })),
  ];
  const logs: Record<string, DiagnosticsLogReport> = {};
  for (const kind of order) {
    const paths = logKinds.get(kind.name);
    if (!paths) continue;
    const budgetBytes = Math.max(
      0,
      Math.min(
        kind.budget,
        limits.bundleBytes - limits.metadataReserveBytes - used,
      ),
    );
    const tail = collectLogTail(paths, {
      maxBytes: budgetBytes,
      lookbackMs: limits.lookbackMs,
      now,
      transform: (text) => scrub(redactString(text)),
    });
    if (tail.filesRead.length === 0) continue;
    files.push({
      name: `logs/${kind.name}`,
      data: tail.text,
      truncated: tail.truncated,
    });
    used += byteSize(tail.text);
    logs[kind.name] = {
      budgetBytes,
      files: tail.filesRead.map((path) => basename(path)),
      keptLines: tail.keptLines,
      droppedLines: tail.droppedLines,
      truncated: tail.truncated,
      ...(tail.truncatedBy ? { truncatedBy: tail.truncatedBy } : {}),
      ...(tail.oldestKept ? { oldestKept: tail.oldestKept } : {}),
      ...(tail.newestKept ? { newestKept: tail.newestKept } : {}),
    };
  }
  files.push({
    name: "logs/README.txt",
    data: scrub(logsReadme(logs, limits, now)),
    truncated: false,
  });

  const manifestFiles = files.map((file) => ({
    name: file.name,
    bytes: byteSize(file.data),
    ...(file.truncated ? { truncated: true } : {}),
  }));
  const manifest: DiagnosticsManifest = {
    schemaVersion: 1,
    bundleId: randomUUID(),
    exportedAt: now.toISOString(),
    ...(typeof input.versions.app === "string"
      ? { appVersion: input.versions.app }
      : {}),
    homeReplaced,
    limits,
    files: manifestFiles,
    totalBytes: manifestFiles.reduce((sum, file) => sum + file.bytes, 0),
    logs,
    ...(state?.errors && Object.keys(state.errors).length > 0
      ? { stateErrors: state.errors }
      : {}),
    ...(input.lastUncleanExit !== undefined
      ? { lastUncleanExit: redactConfig(input.lastUncleanExit) }
      : {}),
  };
  const entries: ZipEntry[] = [
    { name: "manifest.json", data: scrub(json(manifest)), mtime: now },
    ...files.map((file) => ({ name: file.name, data: file.data, mtime: now })),
  ];
  return createZip(entries);
}

/** `logs/README.txt`: what window and budgets the log tails were cut to. */
export function logsReadme(
  logs: Record<string, DiagnosticsLogReport>,
  limits: DiagnosticsLimits,
  now: Date,
): string {
  const hours = limits.lookbackMs / 3_600_000;
  const lines = [
    "Harbormaster diagnostics: log tails",
    "",
    `Logs are not raw copies. Each log (all its rotations, newest first) is cut to`,
    `the records of the last ${hours} hours (since ${new Date(now.getTime() - limits.lookbackMs).toISOString()})`,
    `and to a byte budget, then secrets are redacted and the home folder may be shown as ~.`,
    `Whole bundle cap: ${limits.bundleBytes} bytes.`,
    "",
  ];
  const names = Object.keys(logs);
  if (names.length === 0) lines.push("No log files were found.");
  for (const name of names) {
    const log = logs[name] as DiagnosticsLogReport;
    lines.push(
      `${name}: budget ${log.budgetBytes} bytes, read ${log.files.join(", ")}`,
      `  kept ${log.keptLines} lines${log.oldestKept ? ` (${log.oldestKept} .. ${log.newestKept})` : ""}, dropped ${log.droppedLines}`,
      `  ${log.truncated ? `truncated (${log.truncatedBy ?? "partial"})` : "complete within the window"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Longest a single core command may take while building `state/`. */
const STATE_COMMAND_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The slice of `CoreCommands` `buildDiagnosticsState` needs (structural, so tests pass fakes). */
export interface DiagnosticsStateCommands extends TasksSummaryCommands {
  getPresence(taskId: string): Promise<PresenceStatus>;
  listLocations(): Promise<KnownLocation[]>;
  listRepositories(): Promise<RepositoryInfo[]>;
  getMessagingStates(): Promise<TaskMessagingState[]>;
}

/** Longest free-text error kept per task (`lastError`, cleanup errors). */
const MAX_ERROR_CHARS = 500;

function shortError(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const redacted = redactString(text);
  return redacted.length > MAX_ERROR_CHARS
    ? `${redacted.slice(0, MAX_ERROR_CHARS)}…`
    : redacted;
}

/** Drops `undefined` values so the JSON stays compact. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}

export interface DiagnosticsStateTask {
  task: Record<string, unknown>;
  binding?: Record<string, unknown>;
  presence?: Record<string, unknown>;
}

export interface DiagnosticsState {
  /** Newest-updated first, so a size cap drops the stalest tasks. */
  tasks?: DiagnosticsStateTask[];
  locations?: KnownLocation[];
  repositories?: Array<Record<string, unknown>>;
  /** Messaging chip state, counts and ids only (no question text). */
  messaging?: Array<Record<string, unknown>>;
  /** Commands that failed or timed out, by name. */
  errors: Record<string, string>;
}

/** One task's identity, states, timestamps, launch, PR and lineage; never `initialPrompt` or any message body. */
export function diagnosticsTask(task: Task): Record<string, unknown> {
  return compact({
    id: task.id,
    kind: task.kind,
    state: task.state,
    title: task.title,
    hasInitialPrompt: Boolean(task.initialPrompt),
    initialPromptDeliveredAt: task.initialPromptDeliveredAt,
    repositoryId: task.repositoryId,
    folderPath: task.folderPath,
    baseRef: task.baseRef,
    harness: task.harness,
    model: task.model,
    thinking: task.thinking,
    sessionModel: task.sessionModel,
    branch: task.branch,
    targetBranch: task.targetBranch,
    pr: task.pr,
    issueRef: task.issueRef,
    awaiting: task.awaiting,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    stateChangedAt: task.stateChangedAt,
    completedAt: task.completedAt,
    archivedAt: task.archivedAt,
    lastError: shortError(task.lastError),
    parentTaskId: task.parentTaskId,
    launchedFromTaskId: task.launchedFromTaskId,
    launch: task.launch,
    cleanup: task.cleanup
      ? compact({
          ...task.cleanup,
          lastError: shortError(task.cleanup.lastError),
        })
      : undefined,
  });
}

function diagnosticsBinding(
  binding: WorkspaceBinding,
): Record<string, unknown> {
  return compact({
    id: binding.id,
    worktreePath: binding.worktreePath,
    branch: binding.branch,
    sessionId: binding.sessionId,
    sessionPath: binding.sessionPath,
    previousSessionPath: binding.previousSessionPath,
    forkFromSessionPath: binding.forkFromSessionPath,
    detached: binding.detached,
    scratch: binding.scratch,
    inPlace: binding.inPlace,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  });
}

/** Presence without the agent's free-text notes/status messages. */
function diagnosticsPresence(
  presence: PresenceStatus,
): Record<string, unknown> {
  const record = presence.record;
  return compact({
    live: presence.live,
    runningTurn: presence.runningTurn,
    record: record
      ? compact({
          pid: record.pid,
          mode: record.mode,
          sessionPath: record.sessionPath,
          logPath: record.logPath,
          startedAt: record.startedAt,
          heartbeatAt: record.heartbeatAt,
          runningTurn: record.runningTurn,
          outcome: record.outcome
            ? { status: record.outcome.status, at: record.outcome.at }
            : undefined,
          ended: record.ended
            ? { status: record.ended.status, at: record.ended.at }
            : undefined,
          status: record.status
            ? {
                state: record.status.state,
                at: record.status.at,
                hasMessage: Boolean(record.status.message),
              }
            : undefined,
        })
      : undefined,
  });
}

/**
 * `state/`: tasks (with binding and presence), registered locations,
 * repositories and messaging chip state, built ONLY from core commands
 * (`listBoard`, `getTaskWorkspace`, `getPresence`, `listLocations`,
 * `listRepositories`, `getMessagingStates`), never a state-file read. A
 * failing command is recorded in `errors` instead of failing the export.
 */
export async function buildDiagnosticsState(
  commands: DiagnosticsStateCommands,
  timeoutMs = STATE_COMMAND_TIMEOUT_MS,
): Promise<DiagnosticsState> {
  const errors: Record<string, string> = {};
  const attempt = async <T>(
    name: string,
    run: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await withTimeout(run(), timeoutMs);
    } catch (error) {
      errors[name] = redactString(
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
  };
  const [columns, locations, repositories, messaging] = await Promise.all([
    attempt("listBoard", () => commands.listBoard()),
    attempt("listLocations", () => commands.listLocations()),
    attempt("listRepositories", () => commands.listRepositories()),
    attempt("getMessagingStates", () => commands.getMessagingStates()),
  ]);
  const tasks = columns
    ?.flatMap((column) => column.groups.flatMap((group) => group.tasks))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const stateTasks = tasks
    ? await Promise.all(
        tasks.map(async (task) => {
          const [binding, presence] = await Promise.all([
            withTimeout(commands.getTaskWorkspace(task.id), timeoutMs).catch(
              () => undefined,
            ),
            withTimeout(commands.getPresence(task.id), timeoutMs).catch(
              () => undefined,
            ),
          ]);
          const entry: DiagnosticsStateTask = { task: diagnosticsTask(task) };
          if (binding) entry.binding = diagnosticsBinding(binding);
          if (presence) entry.presence = diagnosticsPresence(presence);
          return entry;
        }),
      )
    : undefined;
  return compact({
    tasks: stateTasks,
    locations,
    repositories: repositories?.map((repo) =>
      compact({
        id: repo.id,
        root: repo.root,
        defaultBranch: repo.defaultBranch,
        remoteUrl: repo.remoteUrl ? redactString(repo.remoteUrl) : undefined,
        checkouts: repo.checkouts,
      }),
    ),
    messaging: messaging?.map((entry) =>
      compact({
        taskId: entry.taskId,
        waitingOnParent: entry.waitingOnParent
          ? compact({
              messageId: entry.waitingOnParent.messageId,
              deliveredAt: entry.waitingOnParent.deliveredAt,
              expiresAt: entry.waitingOnParent.expiresAt,
            })
          : undefined,
        childQuestionsWaiting: entry.childQuestionsWaiting,
        approvalsWaiting: entry.approvalsWaiting,
        loopCapReached: entry.loopCapReached,
      }),
    ),
    errors,
  }) as DiagnosticsState;
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
  /** Every built-in agent (the harness registry), in registration order. */
  agents: EnvironmentAgentInfo[];
  piExtension?: ExtensionFileInfo;
}

/** One agent CLI in `environment.json`: its launch command, where it resolves, and its `--version` output. */
export interface EnvironmentAgentInfo {
  /** Harness id. */
  id: string;
  command: string;
  resolved?: string;
  /** The resolved file is a terminal multiplexer's shim, not the agent. */
  shim?: boolean;
  version?: string;
}

export interface BuildEnvironmentInfoInput {
  app: string;
  electron: string;
  node: string;
  platform: string;
  path: string;
  shell?: string;
  agents: EnvironmentAgentInfo[];
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
    agents: input.agents,
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
