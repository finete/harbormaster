import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonTaskStateAccess } from "../src/access/json-task-state-access.js";
import type { Task } from "../src/contracts/model.js";

describe("JsonTaskStateAccess", () => {
  let dir: string;
  let access: JsonTaskStateAccess;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harbormaster-core-test-"));
    access = new JsonTaskStateAccess(join(dir, "tasks.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "task-1",
    kind: "task",
    state: "backlog",
    title: "Write tests",
    initialPrompt: "Write some tests",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stateChangedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  it("round-trips a task through create/list/get", async () => {
    expect(await access.listTasks()).toEqual([]);
    const task = makeTask();
    await access.createTask(task);

    expect(await access.listTasks()).toEqual([task]);
    expect(await access.getTask(task.id)).toEqual(task);
    expect(await access.getTask("missing")).toBeUndefined();
  });

  it("round-trips through a fresh instance pointed at the same file (persists to disk)", async () => {
    const task = makeTask();
    await access.createTask(task);

    const reopened = new JsonTaskStateAccess(access.statePath);
    expect(await reopened.listTasks()).toEqual([task]);
  });

  it("replaceTask overwrites an existing task", async () => {
    const task = makeTask();
    await access.createTask(task);
    const updated = {
      ...task,
      title: "Write more tests",
      state: "dev" as const,
    };
    await access.replaceTask(updated);

    expect(await access.getTask(task.id)).toEqual(updated);
  });

  it("replaceTask rejects an unknown id", async () => {
    await expect(
      access.replaceTask(makeTask({ id: "missing" })),
    ).rejects.toThrow(/not found/);
  });

  it("createTask rejects a duplicate id", async () => {
    await access.createTask(makeTask());
    await expect(access.createTask(makeTask())).rejects.toThrow(
      /already exists/,
    );
  });

  it("removeTask deletes a task", async () => {
    const task = makeTask();
    await access.createTask(task);
    await access.removeTask(task.id);

    expect(await access.listTasks()).toEqual([]);
  });
});
