// Manager: orchestrates the one-way pi-home → Harbormaster migration.
// Resolves every volatile input (pi-home state file, Beads CLI, presence
// registry, worktree existence, Harbormaster's own task store) through
// access-layer services, hands the plain data to the pure
// `engine/migration-planner`, and — only on a confirmed `--apply` — writes
// the plan through Harbormaster's existing `JsonTaskStateAccess` /
// `JsonWorkspaceBindingAccess` and flips `automation: false` in pi-home's
// config (the one write into pi-home's home anywhere in this module).

import { join } from "node:path";
import {
  JsonTaskStateAccess,
  JsonWorkspaceBindingAccess,
  SessionPresenceAccess,
} from "../../access/index.js";
import { presenceIsLive } from "../../harness/presence-heuristics.js";
import { UuidGenerator } from "../../utilities/defaults.js";
import { PiHomeBeadsAccess } from "../access/pihome-beads-access.js";
import { PiHomeConfigAccess } from "../access/pihome-config-access.js";
import { PiHomeStateFileAccess } from "../access/pihome-state-file-access.js";
import { WorktreeProbeAccess } from "../access/worktree-probe-access.js";
import type {
  BeadsIssue,
  MigrationOptions,
  MigrationReport,
} from "../contracts.js";
import { planMigration } from "../engine/migration-planner.js";

export interface MigrationManagerDeps {
  stateFile?: PiHomeStateFileAccess;
  beads?: PiHomeBeadsAccess;
  presence?: SessionPresenceAccess;
  config?: PiHomeConfigAccess;
  worktrees?: WorktreeProbeAccess;
  tasks?: JsonTaskStateAccess;
  bindings?: JsonWorkspaceBindingAccess;
  now?: () => Date;
  nextId?: () => string;
}

export async function runMigration(
  options: MigrationOptions,
  deps: MigrationManagerDeps = {},
): Promise<MigrationReport> {
  const stateFile =
    deps.stateFile ?? new PiHomeStateFileAccess(options.piHomeDir);
  const beads =
    deps.beads ?? new PiHomeBeadsAccess(join(options.piHomeDir, "beads"));
  const presence =
    deps.presence ??
    new SessionPresenceAccess(join(options.piHomeDir, "presence"));
  const config = deps.config ?? new PiHomeConfigAccess(options.piHomeDir);
  const worktrees = deps.worktrees ?? new WorktreeProbeAccess();
  const tasks =
    deps.tasks ?? new JsonTaskStateAccess(join(options.stateDir, "tasks.json"));
  const bindings =
    deps.bindings ??
    new JsonWorkspaceBindingAccess(
      join(options.stateDir, "workspace-bindings.json"),
    );
  const ids = new UuidGenerator();
  const nextId = deps.nextId ?? (() => ids.next());
  const now = deps.now ?? (() => new Date());

  const piHomeState = await stateFile.read();

  let beadsIssues: BeadsIssue[] = [];
  const warnings: string[] = [];
  try {
    beadsIssues = await beads.listIssues();
  } catch (error) {
    warnings.push(
      `Could not read pi-home's Beads database — permanent tasks cannot be migrated without it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const beadsIssuesById = new Map(
    beadsIssues.map((issue) => [issue.id, issue]),
  );

  const existingTasks = await tasks.listTasks();
  const alreadyImported = new Set(
    existingTasks
      .map((task) => task.pihomeIssueId)
      .filter((value): value is string => Boolean(value)),
  );

  const worktreePaths = new Set<string>();
  for (const binding of piHomeState.workspaceBindings) {
    if (binding.worktreePath) worktreePaths.add(binding.worktreePath);
  }
  for (const workspace of piHomeState.temporaryWorkspaces) {
    if (workspace.worktreePath) worktreePaths.add(workspace.worktreePath);
  }
  const worktreeExists = new Map<string, boolean>();
  for (const path of worktreePaths) {
    worktreeExists.set(path, await worktrees.exists(path));
  }

  const plan = planMigration({
    piHome: piHomeState,
    beadsIssuesById,
    alreadyImported,
    worktreeExists,
    nextId,
  });

  const imported = plan.results.filter((item) => item.status === "imported");
  const skipped = plan.results.filter((item) => item.status === "skipped");
  const planWarnings = plan.results
    .filter((item) => item.status === "warning")
    .map(
      (item) =>
        `${item.pihomeIssueId} (${item.title}): ${item.reason ?? "skipped"}`,
    );
  warnings.push(...planWarnings);

  const livePresence = (await presence.list()).filter((record) =>
    presenceIsLive(record, now()),
  );

  if (!options.apply) {
    return {
      dryRun: true,
      imported,
      skipped,
      warnings,
      livePresenceBlocking: [],
      automationDisabledInPiHome: false,
    };
  }

  if (livePresence.length > 0 && !options.force) {
    warnings.push(
      `Refusing --apply: ${livePresence.length} pi-home task(s) have a live session attached. ` +
        "Close those panes (or pass --force once you've confirmed it's safe) and re-run.",
    );
    return {
      dryRun: true,
      imported: [],
      skipped,
      warnings,
      livePresenceBlocking: livePresence,
      automationDisabledInPiHome: false,
    };
  }

  for (const candidate of plan.toImport) {
    await tasks.createTask(candidate.task);
    if (candidate.binding) await bindings.attachBinding(candidate.binding);
  }

  let automationDisabledInPiHome = false;
  if (imported.length > 0) {
    await config.disableAutomation();
    automationDisabledInPiHome = true;
    warnings.push(
      "pi-home's automation flag was set to false in its config.json so its movers stop touching " +
        "migrated tasks. This is the one write this tool makes into pi-home's home directory — " +
        'reverse it by setting "automation": true back if you ever need pi-home\'s automation again.',
    );
  }

  return {
    dryRun: false,
    imported,
    skipped,
    warnings,
    livePresenceBlocking: [],
    automationDisabledInPiHome,
  };
}
