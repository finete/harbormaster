// Integration tests against FIXTURE copies of pi-home's real shapes: a
// minimal state.json, a fake `bd` CLI (no real Beads database touched), and
// fake presence records — all under a temp dir. Never reads/writes the real
// `~/.pi` home.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JsonTaskStateAccess,
  JsonWorkspaceBindingAccess,
  SessionPresenceAccess,
} from "../../src/access/index.js";
import { PiHomeBeadsAccess } from "../../src/migration/access/pihome-beads-access.js";
import { PiHomeConfigAccess } from "../../src/migration/access/pihome-config-access.js";
import { PiHomeStateFileAccess } from "../../src/migration/access/pihome-state-file-access.js";
import { WorktreeProbeAccess } from "../../src/migration/access/worktree-probe-access.js";
import { runMigration } from "../../src/migration/manager/migration-manager.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

describe("runMigration", () => {
  let root: string;
  let piHomeDir: string;
  let stateDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "harbormaster-migration-test-"));
    piHomeDir = join(root, "pihome");
    stateDir = join(root, "harbormaster");
    await mkdir(piHomeDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedPiHomeState(): Promise<void> {
    await writeJson(join(piHomeDir, "state.json"), {
      version: 4,
      workspaceBindings: [
        {
          id: "binding-1",
          issueId: "pih-aaa",
          repository: {
            id: "github.com/acme/widgets",
            name: "widgets",
            remote: "git@github.com:acme/widgets.git",
            preferredCheckout: "/code/widgets",
            defaultBranch: "main",
          },
          worktreePath: join(root, "worktrees", "widgets-branch"),
          branch: "moshe/do-thing",
          sessionPath: join(root, "sessions", "binding-1.jsonl"),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      temporaryWorkspaces: [
        {
          id: "temp-1",
          kind: "temp_task",
          state: "dev",
          title: "Quick scratch task",
          initialPrompt: "do a quick thing",
          sessionPath: join(root, "sessions", "temp-1.jsonl"),
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T01:00:00.000Z",
          stateChangedAt: "2026-02-01T01:00:00.000Z",
        },
      ],
    });
  }

  async function seedPiHomeConfig(
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await writeJson(join(piHomeDir, "config.json"), {
      branchPrefix: "moshe/",
      codeRoot: "~/Code",
      automation: true,
      movers: ["github-review"],
      ...extra,
    });
  }

  function fakeBeadsAccess(): PiHomeBeadsAccess {
    const execute = async (command: string, args: string[]) => {
      expect(command).toBe("bd");
      expect(args).toEqual(["list", "--all", "--json"]);
      return JSON.stringify([
        {
          id: "pih-aaa",
          title: "Do the thing",
          description: "Please do the thing.",
          status: "in_progress",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          metadata: {
            repository_id: "github.com/acme/widgets",
            pi_home_task_id: "binding-1",
          },
        },
      ]);
    };
    return new PiHomeBeadsAccess(join(piHomeDir, "beads"), execute);
  }

  function deps() {
    return {
      stateFile: new PiHomeStateFileAccess(piHomeDir),
      beads: fakeBeadsAccess(),
      presence: new SessionPresenceAccess(join(piHomeDir, "presence")),
      config: new PiHomeConfigAccess(piHomeDir),
      worktrees: new WorktreeProbeAccess(),
      tasks: new JsonTaskStateAccess(join(stateDir, "tasks.json")),
      bindings: new JsonWorkspaceBindingAccess(
        join(stateDir, "workspace-bindings.json"),
      ),
    };
  }

  it("dry-run reports what would be imported without writing anything", async () => {
    await seedPiHomeState();
    await seedPiHomeConfig();
    const d = deps();

    const report = await runMigration(
      { piHomeDir, stateDir, apply: false, force: false },
      d,
    );

    expect(report.dryRun).toBe(true);
    expect(report.imported.map((i) => i.pihomeIssueId).sort()).toEqual([
      "pih-aaa",
      "temp-1",
    ]);
    expect(report.automationDisabledInPiHome).toBe(false);

    const tasks = await d.tasks.listTasks();
    expect(tasks).toHaveLength(0);
    const config = JSON.parse(
      await readFile(join(piHomeDir, "config.json"), "utf8"),
    );
    expect(config.automation).toBe(true);
  });

  it("--apply writes tasks + bindings and flips pi-home automation off (the one write)", async () => {
    await seedPiHomeState();
    await seedPiHomeConfig();
    const d = deps();

    const report = await runMigration(
      { piHomeDir, stateDir, apply: true, force: false },
      d,
    );

    expect(report.dryRun).toBe(false);
    expect(report.imported).toHaveLength(2);
    expect(report.automationDisabledInPiHome).toBe(true);

    const tasks = await d.tasks.listTasks();
    expect(tasks).toHaveLength(2);
    const permanent = tasks.find((t) => t.pihomeIssueId === "pih-aaa")!;
    expect(permanent.title).toBe("Do the thing");
    expect(permanent.state).toBe("dev");
    const scratch = tasks.find((t) => t.pihomeIssueId === "temp-1")!;
    expect(scratch.title).toBe("Quick scratch task [temp]");

    const bindings = await d.bindings.listBindings();
    expect(bindings).toHaveLength(2);
    const permanentBinding = bindings.find((b) => b.taskId === permanent.id)!;
    expect(permanentBinding.sessionPath).toBe(
      join(root, "sessions", "binding-1.jsonl"),
    );
    // Worktree path never existed on disk in this fixture → omitted, binding still kept.
    expect(permanentBinding.worktreePath).toBeUndefined();

    const config = JSON.parse(
      await readFile(join(piHomeDir, "config.json"), "utf8"),
    );
    expect(config.automation).toBe(false);
    // Everything else round-trips untouched.
    expect(config.movers).toEqual(["github-review"]);
    expect(config.branchPrefix).toBe("moshe/");
  });

  it("keeps the worktreePath on the binding when it is verified present on disk", async () => {
    await seedPiHomeState();
    await seedPiHomeConfig();
    await mkdir(join(root, "worktrees", "widgets-branch"), { recursive: true });
    const d = deps();

    const report = await runMigration(
      { piHomeDir, stateDir, apply: true, force: false },
      d,
    );
    expect(report.imported).toHaveLength(2);

    const tasks = await d.tasks.listTasks();
    const permanent = tasks.find((t) => t.pihomeIssueId === "pih-aaa")!;
    const bindings = await d.bindings.listBindings();
    const binding = bindings.find((b) => b.taskId === permanent.id)!;
    expect(binding.worktreePath).toBe(
      join(root, "worktrees", "widgets-branch"),
    );
    expect(binding.branch).toBe("moshe/do-thing");
  });

  it("is idempotent: a second --apply run imports nothing new", async () => {
    await seedPiHomeState();
    await seedPiHomeConfig();
    const d = deps();

    await runMigration({ piHomeDir, stateDir, apply: true, force: false }, d);
    const second = await runMigration(
      { piHomeDir, stateDir, apply: true, force: false },
      deps2(d),
    );

    expect(second.imported).toHaveLength(0);
    expect(second.skipped.map((s) => s.pihomeIssueId).sort()).toEqual([
      "pih-aaa",
      "temp-1",
    ]);

    const tasks = await d.tasks.listTasks();
    expect(tasks).toHaveLength(2);

    function deps2(original: ReturnType<typeof deps>) {
      // Re-run against the same on-disk stores (new access instances, same paths).
      return {
        ...original,
        stateFile: new PiHomeStateFileAccess(piHomeDir),
        beads: fakeBeadsAccess(),
        presence: new SessionPresenceAccess(join(piHomeDir, "presence")),
        config: new PiHomeConfigAccess(piHomeDir),
      };
    }
  });

  it("refuses --apply when pi-home shows a live presence record, and lists it", async () => {
    await seedPiHomeState();
    await seedPiHomeConfig();
    await writeJson(join(piHomeDir, "presence", "binding-1.json"), {
      taskId: "binding-1",
      sessionPath: join(root, "sessions", "binding-1.jsonl"),
      pid: 999999,
      mode: "interactive",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    const d = deps();

    const report = await runMigration(
      { piHomeDir, stateDir, apply: true, force: false },
      d,
    );

    expect(report.dryRun).toBe(true);
    expect(report.imported).toHaveLength(0);
    expect(report.livePresenceBlocking).toHaveLength(1);
    expect(report.livePresenceBlocking[0]!.taskId).toBe("binding-1");
    expect(report.warnings.join("\n")).toMatch(/live session/);

    const tasks = await d.tasks.listTasks();
    expect(tasks).toHaveLength(0);
    const config = JSON.parse(
      await readFile(join(piHomeDir, "config.json"), "utf8"),
    );
    expect(config.automation).toBe(true);
  });

  it("--force proceeds with --apply despite a live presence record", async () => {
    await seedPiHomeState();
    await seedPiHomeConfig();
    await writeJson(join(piHomeDir, "presence", "binding-1.json"), {
      taskId: "binding-1",
      sessionPath: join(root, "sessions", "binding-1.jsonl"),
      pid: 999999,
      mode: "interactive",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    const d = deps();

    const report = await runMigration(
      { piHomeDir, stateDir, apply: true, force: true },
      d,
    );

    expect(report.dryRun).toBe(false);
    expect(report.imported).toHaveLength(2);
    const tasks = await d.tasks.listTasks();
    expect(tasks).toHaveLength(2);
  });

  it("ignores a stale (ended / heartbeat expired) presence record", async () => {
    await seedPiHomeState();
    await seedPiHomeConfig();
    await writeJson(join(piHomeDir, "presence", "binding-1.json"), {
      taskId: "binding-1",
      sessionPath: join(root, "sessions", "binding-1.jsonl"),
      pid: 999999,
      mode: "headless",
      startedAt: "2020-01-01T00:00:00.000Z",
      heartbeatAt: "2020-01-01T00:00:00.000Z",
      ended: { status: "done", at: "2020-01-01T00:05:00.000Z" },
    });
    const d = deps();

    const report = await runMigration(
      { piHomeDir, stateDir, apply: true, force: false },
      d,
    );

    expect(report.dryRun).toBe(false);
    expect(report.imported).toHaveLength(2);
  });
});
