import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardColumn, Clock, Task } from "../src/contracts/index.js";
import { type Core, createCore } from "../src/index.js";

class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

let counter = 0;
const sequentialIds = { next: () => `id-${++counter}` };

const columnTasks = (column: BoardColumn): Task[] =>
  column.groups.flatMap((group) => group.tasks);

describe("createCore", () => {
  let dir: string;
  let core: Core;
  let clock: FixedClock;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harbormaster-core-test-"));
    counter = 0;
    clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    // An empty temp codeRoot: without it the default (~/Code) would make
    // repository discovery scan the developer's real checkouts.
    await mkdir(join(dir, "Code"));
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ codeRoot: join(dir, "Code") }),
    );
    core = createCore({ stateDir: dir, clock, ids: sequentialIds });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts with an empty board across all four columns", async () => {
    const columns = await core.commands.listBoard();
    expect(columns.map((c) => c.state)).toEqual([
      "backlog",
      "working",
      "awaiting",
      "done",
    ]);
    expect(columns.every((c) => columnTasks(c).length === 0)).toBe(true);
  });

  it("createTask adds the task to the backlog column and getTask finds it", async () => {
    const task = await core.commands.createTask({
      title: "Ship phase 1",
      initialPrompt: "Port pi-home core",
    });

    expect(task.state).toBe("backlog");
    // No repository: scratch ("chat") work.
    expect(task.kind).toBe("temp_task");

    const columns = await core.commands.listBoard();
    const backlog = columns.find((c) => c.state === "backlog") as BoardColumn;
    expect(columnTasks(backlog)).toEqual([task]);

    expect(await core.commands.getTask(task.id)).toEqual(task);
  });

  it("moveTask transitions a task between columns and updates stateChangedAt", async () => {
    const task = await core.commands.createTask({
      title: "Ship phase 1",
      initialPrompt: "Port pi-home core",
    });
    clock.advance(1000);

    const moved = await core.commands.moveTask(task.id, "working");
    expect(moved.state).toBe("working");
    expect(moved.stateChangedAt).not.toBe(task.stateChangedAt);

    const columns = await core.commands.listBoard();
    expect(columnTasks(columns.find((c) => c.state === "backlog")!)).toEqual(
      [],
    );
    expect(columnTasks(columns.find((c) => c.state === "working")!)).toEqual([
      moved,
    ]);
  });

  it("moveTask rejects an illegal transition", async () => {
    const task = await core.commands.createTask({
      title: "Ship phase 1",
      initialPrompt: "Port pi-home core",
    });
    // backlog -> awaiting is the illegal edge (backlog may go to working or done).
    await expect(
      core.commands.moveTask(task.id, "awaiting", {
        awaiting: { kind: "review" },
      }),
    ).rejects.toThrow(/Cannot move/);
  });

  it("moveTask to awaiting requires an awaiting reason", async () => {
    const task = await core.commands.createTask({
      title: "Ship phase 1",
      initialPrompt: "Port pi-home core",
    });
    await core.commands.moveTask(task.id, "working");

    await expect(core.commands.moveTask(task.id, "awaiting")).rejects.toThrow(
      /awaiting reason/,
    );
  });

  it("moveTask to awaiting stores the awaiting reason and clears it on exit", async () => {
    const task = await core.commands.createTask({
      title: "Ship phase 1",
      initialPrompt: "Port pi-home core",
    });
    await core.commands.moveTask(task.id, "working");

    const awaiting = await core.commands.moveTask(task.id, "awaiting", {
      awaiting: { kind: "review" },
    });
    expect(awaiting.awaiting).toEqual({ kind: "review" });

    const backToDev = await core.commands.moveTask(task.id, "working");
    expect(backToDev.awaiting).toBeUndefined();
  });

  it("moveTask within awaiting updates the stored reason", async () => {
    const task = await core.commands.createTask({
      title: "Ship phase 1",
      initialPrompt: "Port pi-home core",
    });
    await core.commands.moveTask(task.id, "working");
    await core.commands.moveTask(task.id, "awaiting", {
      awaiting: { kind: "review" },
    });

    const updated = await core.commands.moveTask(task.id, "awaiting", {
      awaiting: { kind: "slack", permalink: "https://acme.slack.com/p1" },
    });
    expect(updated.awaiting).toEqual({
      kind: "slack",
      permalink: "https://acme.slack.com/p1",
    });
  });

  it("createTask with no repositoryId leaves branch/targetBranch unset", async () => {
    const task = await core.commands.createTask({
      title: "Ship phase 1",
      initialPrompt: "Port pi-home core",
    });

    expect(task.repositoryId).toBeUndefined();
    expect(task.branch).toBeUndefined();
    expect(task.targetBranch).toBeUndefined();
  });

  it("createTask rejects an unknown repositoryId (no git fixture discoverable under this temp codeRoot) and creates no task", async () => {
    await expect(
      core.commands.createTask({
        title: "Ship phase 1",
        initialPrompt: "Port pi-home core",
        repositoryId: "github.com/org/repo",
      }),
    ).rejects.toThrow("Repository not found");

    const columns = await core.commands.listBoard();
    expect(columns.every((c) => columnTasks(c).length === 0)).toBe(true);
  });

  it("updateTaskState patches fields without moving columns", async () => {
    const task = await core.commands.createTask({
      title: "Ship phase 1",
      initialPrompt: "Port pi-home core",
    });
    const updated = await core.commands.updateTaskState(task.id, {
      title: "Ship phase 1 (renamed)",
    });

    expect(updated.title).toBe("Ship phase 1 (renamed)");
    expect(updated.state).toBe("backlog");
  });

  it("setTaskParent nests an existing task, un-nests it, and refuses cycles and too-deep trees", async () => {
    const make = (title: string) =>
      core.commands.createTask({ title, initialPrompt: title });
    const parent = await make("Parent");
    const loose = await make("Loose");
    const other = await make("Other");

    const nested = await core.commands.setTaskParent(loose.id, parent.id);
    expect(nested.parentTaskId).toBe(parent.id);
    expect((await core.commands.getTask(loose.id))?.parentTaskId).toBe(
      parent.id,
    );
    expect(await core.commands.listChildren(parent.id)).toEqual([nested]);
    // Same parent again: a no-op.
    expect(await core.commands.setTaskParent(loose.id, parent.id)).toEqual(
      nested,
    );

    // Deeper nesting is allowed (default max depth 3): a grandchild.
    const grandchild = await core.commands.setTaskParent(other.id, loose.id);
    expect(grandchild.parentTaskId).toBe(loose.id);
    // Never a cycle (under itself or its own descendant), nor an unknown task.
    await expect(
      core.commands.setTaskParent(parent.id, other.id),
    ).rejects.toThrow(/own subtask/);
    await expect(
      core.commands.setTaskParent(other.id, other.id),
    ).rejects.toThrow(/its own parent/);
    await expect(
      core.commands.setTaskParent(other.id, "missing"),
    ).rejects.toThrow(/Task not found/);
    // A fourth level is past the default max depth of 3.
    const extra = await make("Extra");
    await expect(
      core.commands.setTaskParent(extra.id, other.id),
    ).rejects.toThrow(/max nesting depth is 3/);

    // Back to standalone, then under another parent.
    const freed = await core.commands.setTaskParent(other.id, null);
    expect(freed.parentTaskId).toBeUndefined();
    expect("parentTaskId" in freed).toBe(false);
    const moved = await core.commands.setTaskParent(loose.id, other.id);
    expect(moved.parentTaskId).toBe(other.id);
    expect(await core.commands.listChildren(parent.id)).toEqual([]);
    expect(await core.commands.listChildren(other.id)).toEqual([moved]);
  });

  it("deleteTask removes the task from the board", async () => {
    const task = await core.commands.createTask({
      title: "Ship phase 1",
      initialPrompt: "Port pi-home core",
    });
    await core.commands.deleteTask(task.id);

    expect(await core.commands.getTask(task.id)).toBeUndefined();
    const columns = await core.commands.listBoard();
    expect(columns.every((c) => columnTasks(c).length === 0)).toBe(true);
  });

  it("emits board-changed on create, move, and delete", async () => {
    const events: BoardColumn[][] = [];
    const unsubscribe = core.events.on("board-changed", (payload) => {
      events.push(payload.columns);
    });

    const task = await core.commands.createTask({
      title: "Ship phase 1",
      initialPrompt: "Port pi-home core",
    });
    await core.commands.moveTask(task.id, "working");
    await core.commands.deleteTask(task.id);

    expect(events).toHaveLength(3);
    expect(
      columnTasks(events[0]!.find((c) => c.state === "backlog")!),
    ).toHaveLength(1);
    expect(
      columnTasks(events[1]!.find((c) => c.state === "working")!),
    ).toHaveLength(1);
    expect(events[2]!.every((c) => columnTasks(c).length === 0)).toBe(true);

    unsubscribe();
  });

  it("emits task-changed with the updated task on create and move", async () => {
    const changes: string[] = [];
    core.events.on("task-changed", (payload) => {
      changes.push(`${payload.task.id}:${payload.task.state}`);
    });

    const task = await core.commands.createTask({
      title: "Ship phase 1",
      initialPrompt: "Port pi-home core",
    });
    await core.commands.moveTask(task.id, "working");

    expect(changes).toEqual([`${task.id}:backlog`, `${task.id}:working`]);
  });

  it("persists tasks to the injected state directory across core instances", async () => {
    const task = await core.commands.createTask({
      title: "Ship phase 1",
      initialPrompt: "Port pi-home core",
    });

    const reopened = createCore({ stateDir: dir, clock, ids: sequentialIds });
    expect(await reopened.commands.getTask(task.id)).toEqual(task);
  });
});
