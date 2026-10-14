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

  it("patchTask applies a patch to the task as persisted now, not a caller's snapshot", async () => {
    const task = makeTask();
    await access.createTask(task);
    const stale = { ...task };
    // Someone else moved the task after `stale` was read.
    await access.replaceTask({ ...task, state: "dev" });

    const patched = await access.patchTask(task.id, (current) => ({
      ...current,
      lastError: "boom",
    }));

    expect(stale.state).toBe("backlog");
    expect(patched).toMatchObject({ state: "dev", lastError: "boom" });
    expect(await access.getTask(task.id)).toEqual(patched);
  });

  it("patchTask leaves the task untouched when the patch returns undefined, and resolves undefined for a missing task", async () => {
    const task = makeTask();
    await access.createTask(task);
    expect(await access.patchTask(task.id, () => undefined)).toEqual(task);
    expect(await access.getTask(task.id)).toEqual(task);
    expect(
      await access.patchTask("missing", (current) => current),
    ).toBeUndefined();
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

  it("round-trips the phase-2a fields (repository/branch/pr/issue/awaiting)", async () => {
    const task = makeTask({
      repositoryId: "github.com/org/repo",
      branch: "feature/x",
      targetBranch: "main",
      pr: { number: 42, state: "open" },
      issueRef: "org/repo#7",
      state: "awaiting",
      awaiting: {
        kind: "deploy",
        stageId: "staging",
        stageLabel: "Staging",
      },
    });
    await access.createTask(task);

    expect(await access.getTask(task.id)).toEqual(task);

    const reopened = new JsonTaskStateAccess(access.statePath);
    expect(await reopened.listTasks()).toEqual([task]);
  });
});
