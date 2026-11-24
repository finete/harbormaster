// Engine (pure): turns raw reader output into the import candidates
// (docs/import.md "Engine"). Merges sessions and orchestrator records per
// canonical folder, classifies the folder, attaches running info (I3, I13:
// session-exact for Claude Code, conservative folder-level for everything
// else), dedupes against the board, hides what is not worth listing,
// proposes a title (I7), preselects (I5, I6), groups and sorts, and counts
// what was left out (I10). No I/O: the manager supplies every fact (realpath,
// git, PRs, the board) as plain data.

import {
  IMPORT_PRESELECT_DAYS,
  IMPORT_TINY_PROMPTS,
  IMPORT_WINDOW_DAYS,
  type ImportBlockReason,
  type ImportCandidate,
  type ImportCandidateGroup,
  type ImportCandidateSession,
  type ImportFolderKind,
  type ImportHiddenReason,
  type ImportOrchestratorRecord,
  type ImportPullRequestInfo,
  type ImportRunningInfo,
  type ImportSessionRecord,
  type ImportSkipReason,
  type ImportSourceId,
  type ImportTitleSource,
  type RunningAgentProcess,
} from "../contracts/import.js";

/** What git and the file system say about one canonical folder (gathered by the manager). */
export interface ImportFolderFacts {
  exists: boolean;
  kind: ImportFolderKind;
  /** `RepositoryInfo.id` for a `worktree` / `checkout`. */
  repositoryId?: string;
  /** Repository display label (rows group by it). */
  groupLabel?: string;
  /** The folder's current branch. */
  branch?: string;
}

/** The board as the dedupe sees it: canonical folder / session → the task that holds it. */
export interface ImportBoardFacts {
  folders: ReadonlyMap<string, string>;
  sessionIds: ReadonlyMap<string, string>;
  sessionPaths: ReadonlyMap<string, string>;
}

export interface ImportEngineInput {
  sessions: readonly ImportSessionRecord[];
  orchestrations: readonly ImportOrchestratorRecord[];
  running: readonly RunningAgentProcess[];
  /** Realpath of a folder (pure lookup the manager prepared). */
  canonical(path: string): string;
  facts(folder: string): ImportFolderFacts | undefined;
  board: ImportBoardFacts;
  pullRequest(folder: string): ImportPullRequestInfo | undefined;
  /** `HarnessCapabilities.fork` of the harness (decision I3, F8). */
  canFork(harness: string): boolean;
  now: Date;
  /** Include items last active before the 30-day window ("show older"). */
  includeOlder?: boolean;
  /** The user's home folder (never a project). */
  homeDir?: string;
  /** Harbormaster's own worktrees root: a folder under it that no task holds is a leftover. */
  worktreesRoot?: string;
}

const DAY_MS = 86_400_000;
const DEFAULT_BRANCHES = new Set([
  "main",
  "master",
  "develop",
  "trunk",
  "HEAD",
]);

/** `feature/add-login_form` → `Add login form`. */
export function humanizeBranch(branch: string): string {
  const leaf = branch.split("/").filter(Boolean).at(-1) ?? branch;
  const words = leaf.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : branch;
}

export function folderName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** Stable candidate id from the canonical folder (FNV-1a, two seeds: no collisions in practice). */
export function importCandidateId(folderPath: string): string {
  const hash = (seed: number) => {
    let value = seed;
    for (let i = 0; i < folderPath.length; i++) {
      value ^= folderPath.charCodeAt(i);
      value = Math.imul(value, 16777619) >>> 0;
    }
    return value.toString(16).padStart(8, "0");
  };
  return `import-${hash(2166136261)}${hash(84696351)}`;
}

/** Decision I7: herdr workspace name → PR title → session title → branch → folder name. */
export function proposeTitle(parts: {
  workspaceName?: string;
  pullRequestTitle?: string;
  sessionTitle?: string;
  branch?: string;
  folderPath: string;
}): { title: string; source: ImportTitleSource } {
  const clean = (value: string | undefined) =>
    value?.replace(/\s+/g, " ").trim();
  const workspace = clean(parts.workspaceName);
  if (workspace) return { title: workspace, source: "herdr" };
  const pr = clean(parts.pullRequestTitle);
  if (pr) return { title: pr, source: "pull-request" };
  const session = clean(parts.sessionTitle);
  if (session) return { title: session, source: "session" };
  if (parts.branch && !DEFAULT_BRANCHES.has(parts.branch)) {
    return { title: humanizeBranch(parts.branch), source: "branch" };
  }
  return { title: folderName(parts.folderPath), source: "folder" };
}

interface Mark {
  where: "herdr" | "terminal";
  precision: "session" | "folder";
}

function runningMessage(mark: Mark, canFork: boolean): string {
  const where = mark.where === "herdr" ? "herdr" : "a terminal";
  const folder =
    mark.precision === "folder"
      ? " (an agent of this kind runs in this folder)"
      : "";
  return `Running in ${where}${folder}: close it there${canFork ? ", or fork it" : ""}.`;
}

/**
 * The running marks of one folder's sessions (decisions I3, I13): herdr's
 * own report first, then the process table. Claude Code processes that
 * published their session mark exactly that one; a Claude process without a
 * session id, and every Pi / Codex / Cursor process, marks EVERY session of
 * its harness in the folder.
 */
function markRunning(
  folder: string,
  sessions: readonly ImportSessionRecord[],
  orchestrations: readonly ImportOrchestratorRecord[],
  processes: readonly RunningAgentProcess[],
  canonical: (path: string) => string,
): Map<string, Mark> {
  const marks = new Map<string, Mark>();
  const mark = (session: ImportSessionRecord, next: Mark) => {
    const existing = marks.get(session.sessionId);
    if (!existing) {
      marks.set(session.sessionId, next);
      return;
    }
    // herdr names the place; a session-exact finding beats a folder-level one.
    marks.set(session.sessionId, {
      where:
        existing.where === "herdr" || next.where === "herdr"
          ? "herdr"
          : "terminal",
      precision:
        existing.precision === "session" || next.precision === "session"
          ? "session"
          : "folder",
    });
  };
  for (const record of orchestrations) {
    if (!record.running) continue;
    const exact = record.sessions.filter((ref) =>
      sessions.some(
        (session) =>
          (ref.sessionId && ref.sessionId === session.sessionId) ||
          (ref.sessionPath && ref.sessionPath === session.sessionPath),
      ),
    );
    for (const session of sessions) {
      const byRef = exact.some(
        (ref) =>
          (ref.sessionId && ref.sessionId === session.sessionId) ||
          (ref.sessionPath && ref.sessionPath === session.sessionPath),
      );
      if (byRef) {
        mark(session, { where: "herdr", precision: "session" });
        continue;
      }
      // Folder-level: refs of that harness without an id, or no usable refs at all.
      const harnessRefs = record.sessions.filter((ref) => ref.harness);
      const sameHarness = harnessRefs.some(
        (ref) => ref.harness === session.harness,
      );
      if (harnessRefs.length === 0 || sameHarness) {
        mark(session, { where: "herdr", precision: "folder" });
      }
    }
  }
  for (const process of processes) {
    if (canonical(process.cwd) !== folder && process.cwd !== folder) {
      // A Claude process that published its session marks that session wherever its cwd is.
      if (process.harness !== "claude-code" || !process.sessionId) continue;
    }
    for (const session of sessions) {
      if (session.harness !== process.harness) continue;
      if (process.sessionId) {
        if (session.sessionId === process.sessionId) {
          mark(session, { where: "terminal", precision: "session" });
        }
      } else if (canonical(process.cwd) === folder || process.cwd === folder) {
        mark(session, { where: "terminal", precision: "folder" });
      }
    }
  }
  return marks;
}

/** Build the listing: groups of candidates, newest first. */
export function buildImportCandidates(
  input: ImportEngineInput,
): ImportCandidateGroup[] {
  const now = input.now.getTime();
  const windowStart = now - IMPORT_WINDOW_DAYS * DAY_MS;
  const preselectStart = now - IMPORT_PRESELECT_DAYS * DAY_MS;

  // 1. Sessions per canonical folder.
  const byFolder = new Map<string, ImportSessionRecord[]>();
  const folderOfSession = new Map<ImportSessionRecord, string>();
  for (const session of input.sessions) {
    const folder = input.canonical(session.cwd);
    folderOfSession.set(session, folder);
    const list = byFolder.get(folder) ?? [];
    list.push(session);
    byFolder.set(folder, list);
  }

  // 2. Orchestrator records join on cwd and on session id / path.
  const orchestrationsByFolder = new Map<string, ImportOrchestratorRecord[]>();
  const join = (folder: string, record: ImportOrchestratorRecord) => {
    const list = orchestrationsByFolder.get(folder) ?? [];
    if (!list.includes(record)) list.push(record);
    orchestrationsByFolder.set(folder, list);
  };
  for (const record of input.orchestrations) {
    join(input.canonical(record.cwd), record);
    for (const ref of record.sessions) {
      for (const session of input.sessions) {
        if (
          (ref.sessionId && ref.sessionId === session.sessionId) ||
          (ref.sessionPath && ref.sessionPath === session.sessionPath)
        ) {
          join(folderOfSession.get(session) as string, record);
        }
      }
    }
  }

  const candidates: ImportCandidate[] = [];
  for (const [folder, records] of byFolder) {
    const ordered = [...records].sort(
      (a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt),
    );
    // Several readers can report one session (never expected): keep the first per id.
    const seen = new Set<string>();
    const sessions = ordered.filter((session) => {
      const key = `${session.harness}:${session.sessionId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const newest = sessions[0] as ImportSessionRecord;
    const lastActiveMs = Date.parse(newest.lastActiveAt);
    if (!input.includeOlder && lastActiveMs < windowStart) continue;

    const facts = input.facts(folder);
    const orchestrations = orchestrationsByFolder.get(folder) ?? [];
    const marks = markRunning(
      folder,
      sessions,
      orchestrations,
      input.running,
      input.canonical,
    );
    const candidateSessions: ImportCandidateSession[] = sessions.map(
      (session) => {
        const mark = marks.get(session.sessionId);
        const canFork = input.canFork(session.harness);
        const running: ImportRunningInfo | undefined = mark
          ? { ...mark, message: runningMessage(mark, canFork) }
          : undefined;
        return {
          harness: session.harness,
          sessionId: session.sessionId,
          sessionPath: session.sessionPath,
          ...(session.title ? { title: session.title } : {}),
          lastActiveAt: session.lastActiveAt,
          userPrompts: session.userPrompts,
          ...(running ? { running } : {}),
          canFork,
        };
      },
    );
    const defaultSession = candidateSessions[0] as ImportCandidateSession;

    // Dedupe against the board (archived tasks included: the manager passes them all).
    let onBoardTaskId = input.board.folders.get(folder);
    for (const session of sessions) {
      onBoardTaskId ??=
        input.board.sessionIds.get(session.sessionId) ??
        input.board.sessionPaths.get(session.sessionPath);
    }

    const kind: ImportFolderKind = facts?.kind ?? "folder";
    const pullRequest =
      kind === "folder" ? undefined : input.pullRequest(folder);
    const branch = facts?.branch ?? newest.branch;
    const workspaceName = orchestrations.find(
      (r) => r.workspaceName,
    )?.workspaceName;
    const { title, source } = proposeTitle({
      ...(workspaceName ? { workspaceName } : {}),
      ...(pullRequest?.title ? { pullRequestTitle: pullRequest.title } : {}),
      ...(defaultSession.title ? { sessionTitle: defaultSession.title } : {}),
      ...(branch ? { branch } : {}),
      folderPath: folder,
    });

    let hidden: ImportHiddenReason | undefined;
    if (folder === "/" || (input.homeDir && folder === input.homeDir)) {
      hidden = "not-a-project";
    } else if (
      input.worktreesRoot &&
      folder.startsWith(`${input.worktreesRoot.replace(/\/+$/, "")}/`) &&
      !onBoardTaskId
    ) {
      hidden = "harbormaster-leftover";
    } else if (sessions.every((s) => s.userPrompts < IMPORT_TINY_PROMPTS)) {
      hidden = "tiny";
    } else if (facts && !facts.exists) {
      hidden = "folder-missing";
    }

    const blocked: ImportBlockReason | undefined = onBoardTaskId
      ? "on-board"
      : defaultSession.running
        ? "running"
        : undefined;
    const prClosed =
      pullRequest?.state === "merged" || pullRequest?.state === "closed";
    const sources: ImportSourceId[] = [
      ...new Set<ImportSourceId>([
        ...(sessions.map((s) => s.harness) as ImportSourceId[]),
        ...(orchestrations.length > 0 ? (["herdr"] as ImportSourceId[]) : []),
      ]),
    ];

    candidates.push({
      id: importCandidateId(folder),
      folderPath: folder,
      kind,
      ...(facts?.repositoryId ? { repositoryId: facts.repositoryId } : {}),
      groupLabel: facts?.groupLabel ?? folderName(folder),
      ...(branch ? { branch } : {}),
      ...(pullRequest ? { pullRequest } : {}),
      title,
      titleSource: source,
      sessions: candidateSessions,
      defaultSessionId: defaultSession.sessionId,
      sources,
      lastActiveAt: newest.lastActiveAt,
      preselected:
        lastActiveMs >= preselectStart && !blocked && !hidden && !prClosed,
      ...(blocked ? { blocked } : {}),
      ...(onBoardTaskId ? { onBoardTaskId } : {}),
      ...(hidden ? { hidden } : {}),
    });
  }

  // 3. Group by repository, newest first.
  const groups = new Map<string, ImportCandidateGroup>();
  for (const candidate of candidates) {
    const id =
      candidate.kind !== "folder" && candidate.repositoryId
        ? candidate.repositoryId
        : `folder:${candidate.folderPath}`;
    const group = groups.get(id) ?? {
      id,
      label: candidate.groupLabel,
      candidates: [],
    };
    group.candidates.push(candidate);
    groups.set(id, group);
  }
  const byRecency = (a: ImportCandidate, b: ImportCandidate) =>
    Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt);
  const result = [...groups.values()];
  for (const group of result) group.candidates.sort(byRecency);
  result.sort(
    (a, b) =>
      byRecency(
        a.candidates[0] as ImportCandidate,
        b.candidates[0] as ImportCandidate,
      ) || a.label.localeCompare(b.label),
  );
  return result;
}

/**
 * Items listed but not imported, by reason (decision I10): a running one
 * (when it was not imported through a fork) and a folder that is gone.
 * Unticked rows, on-board, tiny, not-a-project and leftover items are not
 * "left out". `skipped` are the import-time refusals of ticked rows.
 */
export function countLeftOut(
  groups: readonly ImportCandidateGroup[],
  imported: ReadonlySet<string>,
  skipped: readonly { candidateId: string; reason: ImportSkipReason }[],
): Partial<Record<ImportSkipReason, number>> {
  const counts: Partial<Record<ImportSkipReason, number>> = {};
  const bump = (reason: ImportSkipReason) => {
    counts[reason] = (counts[reason] ?? 0) + 1;
  };
  const skippedIds = new Set(skipped.map((entry) => entry.candidateId));
  for (const entry of skipped) bump(entry.reason);
  for (const group of groups) {
    for (const candidate of group.candidates) {
      if (imported.has(candidate.id) || skippedIds.has(candidate.id)) continue;
      if (candidate.blocked === "on-board") continue;
      if (candidate.hidden === "folder-missing") bump("folder-missing");
      else if (candidate.blocked === "running" && !candidate.hidden)
        bump("running");
    }
  }
  return counts;
}

/** "Imported 12 tasks from Claude Code, Codex and herdr" (+ " · 3 left out (running elsewhere: 2, folder missing: 1)"). */
export function summarizeImport(
  taskCount: number,
  sourceLabels: readonly string[],
  leftOut: Partial<Record<ImportSkipReason, number>>,
): { title: string; body?: string } {
  const labels = [...new Set(sourceLabels)];
  const joined =
    labels.length <= 1
      ? (labels[0] ?? "your agents")
      : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  const reasons: Record<ImportSkipReason, string> = {
    running: "running elsewhere",
    "on-board": "already in Harbormaster",
    "folder-missing": "folder missing",
    "session-missing": "session missing",
    "cannot-fork": "cannot fork",
    error: "failed",
  };
  const entries = (Object.keys(reasons) as ImportSkipReason[])
    .filter((reason) => (leftOut[reason] ?? 0) > 0)
    .map((reason) => ({ reason, count: leftOut[reason] as number }));
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  const noun = taskCount === 1 ? "task" : "tasks";
  let title = `Imported ${taskCount} ${noun} from ${joined}`;
  if (total > 0) {
    title += ` · ${total} left out (${entries.map((e) => `${reasons[e.reason]}: ${e.count}`).join(", ")})`;
  }
  return {
    title,
    ...(total > 0
      ? {
          body: entries
            .map((e) => `${reasons[e.reason]}: ${e.count}`)
            .join("\n"),
        }
      : {}),
  };
}
