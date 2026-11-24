// Manager (sequence only): the import workflow (docs/import.md "Manager").
// Reads every source concurrently, gathers the folder / PR / board facts the
// pure engine needs, and for `importItems` re-lists (state may have moved),
// validates each selection, and creates the tasks through the CoreManager's
// own task-creation path (`createTask` for the task record, the workspace
// provisioning shared with it for the binding). No storage or process is
// touched here directly: every verb goes through an access interface.

import type {
  PullRequestAccess,
  PullRequestStatus,
} from "../contracts/github.js";
import {
  IMPORT_TINY_PROMPTS,
  IMPORT_WINDOW_DAYS,
  type ImportCandidate,
  type ImportCandidateGroup,
  type ImportCandidateListing,
  type ImportCandidateSession,
  type ImportItemsInput,
  type ImportItemsResult,
  type ImportProcessAccess,
  type ImportPullRequestInfo,
  type ImportSkipReason,
  type ImportSourceId,
  type ImportSourceReader,
  type ImportSourceReading,
  type ListImportCandidatesInput,
  type UndoImportResult,
} from "../contracts/import.js";
import type { CoreLogger } from "../contracts/logger.js";
import type { Task } from "../contracts/model.js";
import type {
  Clock,
  FolderAccess,
  IdGenerator,
  TaskStateAccess,
  WorkspaceBindingAccess,
} from "../contracts/services.js";
import type {
  GitFolderInspection,
  GitRepositoryAccess,
  GitWorktreeAccess,
  RepositoryInfo,
} from "../contracts/workspace.js";
import {
  buildImportCandidates,
  countLeftOut,
  type ImportBoardFacts,
  type ImportFolderFacts,
  summarizeImport,
} from "../engines/import.js";
import { repositoryLabel } from "../engines/repository-label.js";
import { forEachConcurrently } from "../utilities/concurrency.js";

/** Everything `createImportedTask` needs for one validated selection. */
export interface ImportedTaskSpec {
  candidate: ImportCandidate;
  session: ImportCandidateSession;
  title: string;
  /** Bind a fork of the session instead of the session (decision I3). */
  fork: boolean;
  batchId: string;
  at: string;
  sources: ImportSourceId[];
}

export interface ImportInboxItemFields {
  title: string;
  body?: string;
  batchId: string;
  taskIds: string[];
}

export interface ImportRuntimeDeps {
  /** The agent store readers plus any orchestrator reader (herdr) the host plugs in. */
  readers: readonly ImportSourceReader[];
  processes?: ImportProcessAccess;
  tasks: TaskStateAccess;
  bindings: WorkspaceBindingAccess;
  repositories: GitRepositoryAccess;
  worktrees: GitWorktreeAccess;
  folders?: FolderAccess;
  pullRequests: PullRequestAccess;
  clock: Clock;
  ids: IdGenerator;
  logger: CoreLogger;
  /** `HarnessCapabilities.fork` per harness id (decision I3): read per listing, custom agents included. */
  forkCapability(): Promise<(harness: string) => boolean>;
  /** Known repositories (code root + registered folders), for labels. */
  knownRepositories(): Promise<RepositoryInfo[]>;
  /** Create the task and its binding; the CoreManager's internal path. */
  createTask(spec: ImportedTaskSpec): Promise<Task>;
  /** Persist the summary inbox item (decision I10); returns its id. */
  addSummary(fields: ImportInboxItemFields): Promise<string>;
  /** Remove an untouched imported task (never its folder, branch or session). */
  removeTask(taskId: string): Promise<void>;
  /** Resolve the summary item(s) of a batch after its undo. */
  resolveSummary(batchId: string): Promise<void>;
  /** The user's home folder (never a project). */
  homeDir?: string;
  /** Harbormaster's own worktrees root (leftovers are hidden). */
  worktreesRoot?: string;
}

/** Git facts are reused briefly: "Check again" re-lists often. */
const FACTS_TTL_MS = 15_000;
const DAY_MS = 86_400_000;
const OLDER_DAYS = 365;
/** `host.tld/owner/repo`: the identities `gh` can look up. */
const GITHUB_STYLE_ID = /^[^/\s]+\.[^/\s]+\/[^/\s]+\/[^/\s]+$/;

function toPullRequestInfo(status: PullRequestStatus): ImportPullRequestInfo {
  return {
    number: status.number,
    url: status.url,
    ...(status.title ? { title: status.title } : {}),
    state:
      status.state === "MERGED"
        ? "merged"
        : status.state === "CLOSED"
          ? "closed"
          : status.isDraft
            ? "draft"
            : "open",
  };
}

export class ImportRuntime {
  private readonly facts = new Map<
    string,
    { at: number; facts: ImportFolderFacts; inspection?: GitFolderInspection }
  >();

  constructor(private readonly deps: ImportRuntimeDeps) {}

  async list(
    input: ListImportCandidatesInput = {},
  ): Promise<ImportCandidateListing> {
    const { deps } = this;
    const now = deps.clock.now();
    const since = new Date(
      now.getTime() -
        (input.includeOlder ? OLDER_DAYS : IMPORT_WINDOW_DAYS) * DAY_MS,
    );
    const readings = await Promise.all(
      deps.readers.map(async (reader) => {
        try {
          return await reader.read({ since });
        } catch (error) {
          return {
            sessions: [],
            orchestrations: [],
            error: error instanceof Error ? error.message : String(error),
          } satisfies ImportSourceReading;
        }
      }),
    );
    const sessions = readings.flatMap((reading) => reading.sessions);
    const orchestrations = readings.flatMap(
      (reading) => reading.orchestrations,
    );
    const canFork = await deps.forkCapability();
    const running = await (
      deps.processes?.listRunningAgents() ?? Promise.resolve([])
    ).catch(() => []);

    // Canonical (realpath) spellings of every folder the engine will compare.
    const tasks = await deps.tasks.listTasks();
    const bindings = await deps.bindings.listBindings();
    const paths = new Set<string>([
      ...sessions.map((s) => s.cwd),
      ...orchestrations.map((o) => o.cwd),
      ...running.map((p) => p.cwd),
      ...bindings.flatMap((b) => (b.worktreePath ? [b.worktreePath] : [])),
      ...tasks.flatMap((t) => (t.folderPath ? [t.folderPath] : [])),
    ]);
    const canonical = new Map<string, string>();
    await forEachConcurrently([...paths], 16, async (path) => {
      canonical.set(path, await deps.worktrees.canonicalPath(path));
    });
    const canon = (path: string) => canonical.get(path) ?? path;

    const board = this.boardFacts(tasks, bindings, canon);
    const prompts = new Map<string, number>();
    for (const session of sessions) {
      const folder = canon(session.cwd);
      prompts.set(
        folder,
        Math.max(prompts.get(folder) ?? 0, session.userPrompts),
      );
    }
    const folderFacts = await this.gatherFacts([...prompts.keys()], prompts);
    const pullRequests = await this.gatherPullRequests(folderFacts, board);

    const groups = buildImportCandidates({
      sessions,
      orchestrations,
      running,
      canonical: canon,
      facts: (folder) => folderFacts.get(folder)?.facts,
      board,
      pullRequest: (folder) => pullRequests.get(folder),
      canFork,
      now,
      ...(input.includeOlder ? { includeOlder: true } : {}),
      ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
      ...(deps.worktreesRoot ? { worktreesRoot: deps.worktreesRoot } : {}),
    });
    return {
      groups,
      sources: deps.readers.map((reader, index) => {
        const reading = readings[index] as ImportSourceReading;
        return {
          id: reader.id,
          label: reader.label,
          found: reading.sessions.length + reading.orchestrations.length,
          ...(reading.error ? { error: reading.error } : {}),
        };
      }),
      scannedAt: now.toISOString(),
    };
  }

  private boardFacts(
    tasks: readonly Task[],
    bindings: readonly {
      taskId: string;
      worktreePath?: string;
      sessionId?: string;
      sessionPath?: string;
      previousSessionPath?: string;
    }[],
    canon: (path: string) => string,
  ): ImportBoardFacts {
    const folders = new Map<string, string>();
    const sessionIds = new Map<string, string>();
    const sessionPaths = new Map<string, string>();
    for (const binding of bindings) {
      if (binding.worktreePath)
        folders.set(canon(binding.worktreePath), binding.taskId);
      if (binding.sessionId) sessionIds.set(binding.sessionId, binding.taskId);
      for (const path of [binding.sessionPath, binding.previousSessionPath]) {
        if (path) sessionPaths.set(path, binding.taskId);
      }
    }
    for (const task of tasks) {
      if (task.folderPath) folders.set(canon(task.folderPath), task.id);
    }
    return { folders, sessionIds, sessionPaths };
  }

  /** Folder / git facts for every folder worth them (tiny items skip git: they are hidden anyway). */
  private async gatherFacts(
    folders: readonly string[],
    prompts: ReadonlyMap<string, number>,
  ): Promise<
    Map<string, { facts: ImportFolderFacts; inspection?: GitFolderInspection }>
  > {
    const { deps } = this;
    const out = new Map<
      string,
      { facts: ImportFolderFacts; inspection?: GitFolderInspection }
    >();
    const nowMs = deps.clock.now().getTime();
    const repositories = await deps.knownRepositories().catch(() => []);
    await forEachConcurrently([...folders], 6, async (folder) => {
      const cached = this.facts.get(folder);
      if (cached && nowMs - cached.at < FACTS_TTL_MS) {
        out.set(folder, cached);
        return;
      }
      const exists = deps.folders
        ? await deps.folders.isDirectory(folder)
        : true;
      let facts: ImportFolderFacts = { exists, kind: "folder" };
      let inspection: GitFolderInspection | undefined;
      const tiny = (prompts.get(folder) ?? 0) < IMPORT_TINY_PROMPTS;
      if (exists && !tiny && deps.repositories.inspectFolder) {
        inspection = await deps.repositories.inspectFolder(folder);
        if (inspection.kind !== "folder") {
          const known = repositories.find(
            (repo) =>
              repo.id === inspection?.repositoryId ||
              repo.checkouts.some(
                (checkout) => checkout.root === inspection?.mainCheckout,
              ),
          );
          const repositoryId = known?.id ?? inspection.repositoryId;
          facts = {
            exists,
            kind: inspection.kind,
            ...(repositoryId ? { repositoryId } : {}),
            groupLabel: known
              ? repositoryLabel(known)
              : (repositoryId ?? folder),
            ...(inspection.branch ? { branch: inspection.branch } : {}),
          };
        }
      }
      const entry = { at: nowMs, facts, ...(inspection ? { inspection } : {}) };
      // Tiny items skipped git: do not cache that as the folder's answer.
      if (!tiny) this.facts.set(folder, entry);
      out.set(folder, entry);
    });
    return out;
  }

  /** PR title/state per folder (one batched lookup per repository); gh failing = no PR info (F9). */
  private async gatherPullRequests(
    facts: ReadonlyMap<string, { facts: ImportFolderFacts }>,
    board: ImportBoardFacts,
  ): Promise<Map<string, ImportPullRequestInfo>> {
    const { deps } = this;
    const result = new Map<string, ImportPullRequestInfo>();
    const wanted = new Map<string, { folder: string; branch: string }[]>();
    for (const [folder, { facts: folderFacts }] of facts) {
      const { repositoryId, branch } = folderFacts;
      if (
        folderFacts.kind === "folder" ||
        !repositoryId ||
        !branch ||
        board.folders.has(folder) ||
        !GITHUB_STYLE_ID.test(repositoryId) ||
        ["main", "master"].includes(branch)
      ) {
        continue;
      }
      const list = wanted.get(repositoryId) ?? [];
      list.push({ folder, branch });
      wanted.set(repositoryId, list);
    }
    await forEachConcurrently(
      [...wanted],
      3,
      async ([repositoryId, entries]) => {
        try {
          const branches = [...new Set(entries.map((entry) => entry.branch))];
          const statuses = deps.pullRequests.statusMany
            ? await deps.pullRequests.statusMany(repositoryId, branches)
            : new Map(
                await Promise.all(
                  branches.map(
                    async (branch) =>
                      [
                        branch,
                        await deps.pullRequests.status(repositoryId, branch),
                      ] as const,
                  ),
                ),
              );
          for (const entry of entries) {
            const status = statuses.get(entry.branch);
            if (status) result.set(entry.folder, toPullRequestInfo(status));
          }
        } catch {
          // No gh, no network, no access: no PR info, never an error.
        }
      },
    );
    return result;
  }

  async importItems(input: ImportItemsInput): Promise<ImportItemsResult> {
    const { deps } = this;
    // State may have moved since the user's listing: never trust cached git facts here.
    this.facts.clear();
    const listing = await this.list(
      input.includeOlder ? { includeOlder: true } : {},
    );
    const candidates = new Map<string, ImportCandidate>();
    for (const group of listing.groups) {
      for (const candidate of group.candidates)
        candidates.set(candidate.id, candidate);
    }
    const batchId = deps.ids.next();
    const at = deps.clock.now().toISOString();
    const imported: ImportItemsResult["imported"] = [];
    const skipped: ImportItemsResult["skipped"] = [];
    const skip = (
      candidateId: string,
      reason: ImportSkipReason,
      detail?: string,
    ) => skipped.push({ candidateId, reason, ...(detail ? { detail } : {}) });
    const seen = new Set<string>();
    const created: {
      task: Task;
      candidate: ImportCandidate;
      session: ImportCandidateSession;
    }[] = [];

    for (const selection of input.items) {
      if (seen.has(selection.candidateId)) continue;
      seen.add(selection.candidateId);
      const candidate = candidates.get(selection.candidateId);
      if (!candidate) {
        skip(selection.candidateId, "error", "no longer listed");
        continue;
      }
      if (candidate.blocked === "on-board") {
        skip(candidate.id, "on-board");
        continue;
      }
      if (candidate.hidden === "folder-missing") {
        skip(candidate.id, "folder-missing");
        continue;
      }
      const session = candidate.sessions.find(
        (s) =>
          s.sessionId === (selection.sessionId || candidate.defaultSessionId),
      );
      if (!session) {
        skip(candidate.id, "session-missing");
        continue;
      }
      const fork = selection.fork === true;
      if (fork && !session.canFork) {
        skip(candidate.id, "cannot-fork");
        continue;
      }
      if (session.running && !fork) {
        skip(candidate.id, "running", session.running.message);
        continue;
      }
      try {
        const sources = [
          ...new Set<ImportSourceId>([
            session.harness as ImportSourceId,
            ...(candidate.sources.includes("herdr")
              ? (["herdr"] as ImportSourceId[])
              : []),
          ]),
        ];
        const task = await deps.createTask({
          candidate,
          session,
          title: selection.title.trim() || candidate.title,
          fork,
          batchId,
          at,
          sources,
        });
        imported.push({ candidateId: candidate.id, taskId: task.id });
        created.push({ task, candidate, session });
      } catch (error) {
        skip(
          candidate.id,
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const leftOut = countLeftOut(
      listing.groups,
      new Set(imported.map((entry) => entry.candidateId)),
      skipped,
    );
    if (imported.length === 0) {
      return { imported, skipped, leftOut };
    }
    const labels = new Map(
      deps.readers.map((reader) => [reader.id as string, reader.label]),
    );
    const sourceLabels = created.flatMap(({ task }) =>
      (task.imported?.sources ?? []).map((id) => labels.get(id) ?? id),
    );
    const summary = summarizeImport(imported.length, sourceLabels, leftOut);
    const body = this.leftOutBody(
      listing.groups,
      skipped,
      new Set(imported.map((i) => i.candidateId)),
    );
    const inboxItemId = await deps
      .addSummary({
        title: summary.title,
        ...(body ? { body } : {}),
        batchId,
        taskIds: imported.map((entry) => entry.taskId),
      })
      .catch(() => undefined);
    deps.logger.info(
      "import",
      `imported ${imported.length} task(s), batch ${batchId}`,
      {
        count: imported.length,
        outcome: "ok",
      },
    );
    return {
      batchId,
      imported,
      skipped,
      leftOut,
      ...(inboxItemId ? { inboxItemId } : {}),
    };
  }

  /** The summary body: what was left out, by reason, one line per item. */
  private leftOutBody(
    groups: readonly ImportCandidateGroup[],
    skipped: ImportItemsResult["skipped"],
    imported: ReadonlySet<string>,
  ): string | undefined {
    const titles = new Map<string, string>();
    const lines = new Map<string, string[]>();
    const add = (reason: string, id: string) => {
      const list = lines.get(reason) ?? [];
      list.push(titles.get(id) ?? id);
      lines.set(reason, list);
    };
    const skippedIds = new Set(skipped.map((s) => s.candidateId));
    for (const group of groups) {
      for (const candidate of group.candidates)
        titles.set(
          candidate.id,
          `${candidate.title} (${candidate.folderPath})`,
        );
    }
    for (const entry of skipped) add(entry.reason, entry.candidateId);
    for (const group of groups) {
      for (const candidate of group.candidates) {
        if (
          imported.has(candidate.id) ||
          skippedIds.has(candidate.id) ||
          candidate.blocked === "on-board"
        )
          continue;
        if (candidate.hidden === "folder-missing")
          add("folder-missing", candidate.id);
        else if (candidate.blocked === "running" && !candidate.hidden)
          add("running", candidate.id);
      }
    }
    if (lines.size === 0) return undefined;
    const names: Record<string, string> = {
      running: "Running elsewhere",
      "on-board": "Already in Harbormaster",
      "folder-missing": "Folder missing",
      "session-missing": "Session missing",
      "cannot-fork": "Cannot fork",
      error: "Failed",
    };
    return [...lines]
      .map(
        ([reason, items]) =>
          `${names[reason] ?? reason}:\n${items.map((i) => `- ${i}`).join("\n")}`,
      )
      .join("\n\n");
  }

  async undo(batchId: string): Promise<UndoImportResult> {
    const { deps } = this;
    const result: UndoImportResult = { batchId, removed: [], kept: [] };
    const now = deps.clock.now().toISOString();
    const tasks = (await deps.tasks.listTasks()).filter(
      (task) => task.imported?.batchId === batchId && !task.imported.undoneAt,
    );
    for (const listed of tasks) {
      // Re-read: the user may have opened the task since the list was read.
      const task = (await deps.tasks.getTask(listed.id)) ?? listed;
      if (task.imported?.touchedAt) {
        result.kept.push({ taskId: task.id, title: task.title });
        await deps.tasks.patchTask(task.id, (fresh) =>
          fresh.imported && !fresh.imported.undoneAt
            ? { ...fresh, imported: { ...fresh.imported, undoneAt: now } }
            : undefined,
        );
        continue;
      }
      await deps.removeTask(task.id);
      result.removed.push(task.id);
    }
    if (tasks.length > 0) await deps.resolveSummary(batchId);
    return result;
  }
}
