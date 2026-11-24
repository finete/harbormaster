// Import existing work (docs/import.md): the plain data that crosses the
// import seams. Two layers:
//
// - Reader side (Resource Access → Engine): every source is one
//   `ImportSourceReader` returning raw `ImportSessionRecord`s (the agent
//   session stores) and/or `ImportOrchestratorRecord`s (herdr), plus the
//   `ImportProcessAccess` snapshot of agents running outside Harbormaster.
// - Command side (Manager ↔ frontends, transportable): the candidates
//   `listImportCandidates` returns, the selection `importItems` takes, and
//   the results of `importItems` / `undoImport` / `removeExternalWorktree`.
//
// No Electron, filesystem-layout or process assumptions leak through the
// command side (AGENTS.md "The API boundary is transportable").

/** A source an item can come from: one of the agent session stores (= its harness id) or an orchestrator. */
export type ImportSourceId =
  | "pi"
  | "claude-code"
  | "codex"
  | "cursor"
  | "herdr";

/** Where a title came from (decision I7), first available wins in this order. */
export type ImportTitleSource =
  | "herdr"
  | "pull-request"
  | "session"
  | "branch"
  | "folder";

// ---------------------------------------------------------------------------
// Reader side (access → engine). Never crosses the command API.
// ---------------------------------------------------------------------------

/** One agent session found in an agent's own store, as its reader returns it. */
export interface ImportSessionRecord {
  /** The harness that wrote it (adapter id: `pi`, `claude-code`, `codex`, `cursor`). */
  harness: string;
  /** The harness's own session id (what `--resume` / `--fork` take). */
  sessionId: string;
  /** The session's file on disk (Pi/Claude/Codex JSONL, Cursor transcript or chat dir). */
  sessionPath: string;
  /** The folder the session ran in, as recorded INSIDE the session (never decoded from a store dir name: those slugs are lossy). Absolute, not yet canonicalized. */
  cwd: string;
  /** ISO time of the session's first entry, when recorded. */
  startedAt?: string;
  /** ISO time of the session's last entry (else the file's mtime). */
  lastActiveAt: string;
  /** Prompts a human typed (no tool results, injected context, hook or harbormaster messages). */
  userPrompts: number;
  /** The agent's own title: Claude `custom-title` (`/rename`) else `ai-title`, Pi `session_info.name` (last), Codex `session_index.jsonl` `thread_name`, Cursor `meta.json` `title`. */
  title?: string;
  /** The branch the store recorded for the session (Claude `gitBranch`, Codex `session_meta.git.branch`), if any. A hint only: the engine reads the folder's current branch from git. */
  branch?: string;
}

/** One session reference an orchestrator holds for a pane. */
export interface ImportOrchestratorSessionRef {
  /** Harness id, mapped from the orchestrator's agent name (`claude` → `claude-code`); absent = an agent we have no adapter for. */
  harness?: string;
  /** The orchestrator's raw agent name (`claude`, `codex`, `pi`, `cursor`, …). */
  agent: string;
  /** Session id (herdr `agent_session.kind == "id"`). */
  sessionId?: string;
  /** Session file (herdr `agent_session.kind == "path"`). */
  sessionPath?: string;
}

/** What an orchestrator (herdr) knows about one folder (decision I2). */
export interface ImportOrchestratorRecord {
  source: "herdr";
  /** herdr session name (`default` or a named session). */
  orchestratorSession: string;
  /** herdr workspace id, when the snapshot has one. */
  workspaceId?: string;
  /** The workspace's `custom_name`: the first title choice (decision I7). */
  workspaceName?: string;
  /** The pane's (else the workspace's identity) cwd. Absolute. */
  cwd: string;
  sessions: ImportOrchestratorSessionRef[];
  /** Live: an agent in one of this folder's panes is running right now (`herdr api snapshot`). */
  running: boolean;
}

/** One reading of one source. A reader never throws for a missing store: it returns empty. */
export interface ImportSourceReading {
  sessions: ImportSessionRecord[];
  orchestrations: ImportOrchestratorRecord[];
  /** Why the reading is partial or empty (unreadable store, unknown format version), for the dialog's footnote. */
  error?: string;
}

export interface ImportReadOptions {
  /** Skip sessions whose last activity is before this time (readers filter by file mtime first, cheaply). */
  since: Date;
}

/** Resource Access: one source's reader (docs/import.md "Sources"). */
export interface ImportSourceReader {
  readonly id: ImportSourceId;
  /** Display label (`"Claude Code"`, `"herdr"`). */
  readonly label: string;
  read(options: ImportReadOptions): Promise<ImportSourceReading>;
}

/** One agent process running outside Harbormaster's ptys. */
export interface RunningAgentProcess {
  /** Harness id. */
  harness: string;
  pid: number;
  /** The process's current directory (`lsof -d cwd`). */
  cwd: string;
  /** Exact session, when the agent publishes it (Claude `~/.claude/sessions/<pid>.json`). Absent = folder-level only. */
  sessionId?: string;
}

/** Resource Access: agents running on this machine (process table + agent-published registries). */
export interface ImportProcessAccess {
  listRunningAgents(): Promise<RunningAgentProcess[]>;
}

// ---------------------------------------------------------------------------
// Command side (transportable).
// ---------------------------------------------------------------------------

/** What the folder is (decision I9). */
export type ImportFolderKind =
  /** A linked git worktree: imported as an External worktree task. */
  | "worktree"
  /** A repository's main checkout: imported as a folder task (never removable). */
  | "checkout"
  /** Not a git repository: imported as a folder task. */
  | "folder";

/** Why a candidate is listed but not selectable, or hidden. */
export type ImportBlockReason =
  /** Already on the board (any task, any column, archived included). */
  | "on-board"
  /** The picked session (or, folder-level, an agent in this folder) is running outside Harbormaster. */
  | "running";

export type ImportHiddenReason =
  /** Every session has fewer than `IMPORT_TINY_PROMPTS` human prompts. */
  | "tiny"
  /** The folder no longer exists. */
  | "folder-missing"
  /** The folder is the home folder or `/` (not a project). */
  | "not-a-project"
  /** A leftover under Harbormaster's own worktrees root that belongs to no task. */
  | "harbormaster-leftover";

/** One session a candidate can bind (the per-row picker, decision I8). */
export interface ImportCandidateSession {
  harness: string;
  sessionId: string;
  sessionPath: string;
  title?: string;
  lastActiveAt: string;
  userPrompts: number;
  /** Set when this session is running outside Harbormaster. */
  running?: ImportRunningInfo;
  /** Whether the harness can copy this session into a new one the adapter's `HarnessCapabilities.fork` (Cursor: no, docs/import.md F8). */
  canFork: boolean;
}

export interface ImportRunningInfo {
  /** `herdr`: a herdr pane; `terminal`: a process found outside any orchestrator. */
  where: "herdr" | "terminal";
  /** Session-exact (the agent published its session id) or folder-level (an agent of this harness runs in this folder: then EVERY session of that harness in the folder is marked running, docs/import.md I13). */
  precision: "session" | "folder";
  /** The row's sentence: "Running in herdr: close it there, or fork it." */
  message: string;
}

export interface ImportPullRequestInfo {
  number: number;
  url: string;
  title?: string;
  state: "draft" | "open" | "merged" | "closed";
}

/** One importable item: one folder + its sessions (decision I1). */
export interface ImportCandidate {
  /** Stable across listings: derived from the canonical folder path. */
  id: string;
  /** Canonical (realpath) folder. */
  folderPath: string;
  kind: ImportFolderKind;
  /** For `worktree` / `checkout`: the repository identity (as `RepositoryInfo.id`). */
  repositoryId?: string;
  /** Display label of the repository (or the folder name for `folder`). Rows group by it (decision I5). */
  groupLabel: string;
  /** Current branch of the folder (git), when it has one. */
  branch?: string;
  pullRequest?: ImportPullRequestInfo;
  /** Proposed title (decision I7) and where it came from (the grey hint). */
  title: string;
  titleSource: ImportTitleSource;
  /** Newest first. Never empty. */
  sessions: ImportCandidateSession[];
  /** The session bound by default: the most recent (decision I8). */
  defaultSessionId: string;
  /** Sources that contributed (`["claude-code", "herdr"]`). */
  sources: ImportSourceId[];
  /** Newest `lastActiveAt` among its sessions. */
  lastActiveAt: string;
  /** Pre-ticked: active in the last `IMPORT_PRESELECT_DAYS` days, selectable, PR not merged/closed (decision I5/I6). */
  preselected: boolean;
  /** Not selectable, with why. Absent = selectable. */
  blocked?: ImportBlockReason;
  /** For `blocked: "on-board"`: the task it already is. */
  onBoardTaskId?: string;
  /** Hidden behind "show hidden" (decision I5). A hidden item stays selectable unless also `blocked`. */
  hidden?: ImportHiddenReason;
}

/** One repository group, newest first (decision I5). */
export interface ImportCandidateGroup {
  /** `repositoryId`, else `folder:<path>`. */
  id: string;
  label: string;
  candidates: ImportCandidate[];
}

export interface ListImportCandidatesInput {
  /** Include items last active more than `IMPORT_WINDOW_DAYS` days ago ("show older"). */
  includeOlder?: boolean;
}

export interface ImportCandidateListing {
  /** Every candidate in the window, hidden ones included (the frontend filters on `hidden`). */
  groups: ImportCandidateGroup[];
  /** Sources that were read, with their label and any error (unreadable store, unknown format). */
  sources: {
    id: ImportSourceId;
    label: string;
    found: number;
    error?: string;
  }[];
  scannedAt: string;
}

/** One ticked row, as the user left it. */
export interface ImportItemSelection {
  candidateId: string;
  /** The picked session (default `defaultSessionId`); fixes the task's agent (decision I8). */
  sessionId: string;
  /** The row's (possibly edited) title. */
  title: string;
  /** "Fork instead" (decision I3): bind a fork of the session instead of the session itself. */
  fork?: boolean;
}

export interface ImportItemsInput {
  items: ImportItemSelection[];
  /** Same window as the listing the user picked from (core re-lists to validate and to count what was left out). */
  includeOlder?: boolean;
}

/** Why `importItems` refused one selected item at import time (state moved since the listing). */
export type ImportSkipReason =
  | "running"
  | "on-board"
  | "folder-missing"
  | "session-missing"
  | "cannot-fork"
  | "error";

export interface ImportItemsResult {
  /** Absent when nothing was imported. */
  batchId?: string;
  imported: { candidateId: string; taskId: string }[];
  skipped: { candidateId: string; reason: ImportSkipReason; detail?: string }[];
  /**
   * Listed items that could not come in, by reason, for the summary
   * (decision I10): `running`, plus `folder-missing` and every import-time
   * skip. Unticked rows, `on-board`, `tiny`, `not-a-project` and
   * `harbormaster-leftover` items are not "left out".
   */
  leftOut: Partial<Record<ImportSkipReason, number>>;
  /** The summary inbox item (decision I10), when one was written. */
  inboxItemId?: string;
}

export interface UndoImportResult {
  batchId: string;
  /** Tasks removed (untouched since the import). Their folders and sessions are left as they are. */
  removed: string[];
  /** Tasks kept because they were opened or changed since the import. */
  kept: { taskId: string; title: string }[];
}

/** Provenance recorded on an imported task (`Task.imported`). Optional field: older state files load unchanged. */
export interface TaskImportInfo {
  batchId: string;
  /** ISO time of the import. */
  at: string;
  sources: ImportSourceId[];
  /** First time the user opened or changed the task after the import (a session launch, a manual move, an edit). Undo keeps such tasks. */
  touchedAt?: string;
}

/** Items active within this many days are listed (decision I5); older ones behind "show older". */
export const IMPORT_WINDOW_DAYS = 30;
/** Items active within this many days are pre-ticked. */
export const IMPORT_PRESELECT_DAYS = 7;
/** Sessions with fewer human prompts than this are "tiny"; an item whose sessions are all tiny is hidden. */
export const IMPORT_TINY_PROMPTS = 3;
