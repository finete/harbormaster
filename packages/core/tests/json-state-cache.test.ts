// Stat-keyed parse cache behind JsonTaskStateAccess and
// JsonWorkspaceBindingAccess (utilities/json-file-cache.ts): repeated reads
// of an unchanged file skip read+parse+validate, every caller still gets a
// private copy, and both external writes and this process's own writes are
// picked up.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonTaskStateAccess } from "../src/access/json-task-state-access.js";
import { JsonWorkspaceBindingAccess } from "../src/access/json-workspace-binding-access.js";
import type { Task, WorkspaceBinding } from "../src/contracts/model.js";

const stamp = "2026-01-01T00:00:00.000Z";
const makeTask = (id: string, title = "Title"): Task => ({
  id,
  kind: "task",
  state: "backlog",
  title,
  initialPrompt: "",
  createdAt: stamp,
  updatedAt: stamp,
  stateChangedAt: stamp,
});
const makeBinding = (taskId: string): WorkspaceBinding => ({
  id: `binding-${taskId}`,
  taskId,
  detached: false,
  createdAt: stamp,
  updatedAt: stamp,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harbormaster-json-cache-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("JsonTaskStateAccess parse cache", () => {
  it("parses an unchanged file once across repeated reads", async () => {
    const access = new JsonTaskStateAccess(join(dir, "tasks.json"));
    await access.createTask(makeTask("a"));
    await access.createTask(makeTask("b"));
    const parse = vi.spyOn(JSON, "parse");
    await access.listTasks();
    await access.listTasks();
    await access.getTask("a");
    await access.patchTask("a", () => undefined);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("returns equal but never identical (or shared) objects", async () => {
    const access = new JsonTaskStateAccess(join(dir, "tasks.json"));
    await access.createTask(makeTask("a"));
    const first = await access.listTasks();
    const second = await access.listTasks();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    (first[0] as Task).title = "mutated by caller";
    first.push(makeTask("z"));
    const one = await access.getTask("a");
    (one as Task).title = "mutated too";
    expect(await access.listTasks()).toEqual([makeTask("a")]);
    // A no-op patch hands back a copy as well.
    const unchanged = await access.patchTask("a", () => undefined);
    (unchanged as Task).title = "mutated again";
    expect((await access.getTask("a"))?.title).toBe("Title");
  });

  it("picks up writes from another instance (another process)", async () => {
    const path = join(dir, "tasks.json");
    const access = new JsonTaskStateAccess(path);
    const other = new JsonTaskStateAccess(path);
    await access.createTask(makeTask("a"));
    expect(await access.listTasks()).toHaveLength(1);
    await other.createTask(makeTask("b"));
    expect((await access.listTasks()).map((task) => task.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("picks up an in-place, same-size external rewrite (same inode)", async () => {
    const path = join(dir, "tasks.json");
    const access = new JsonTaskStateAccess(path);
    await access.createTask(makeTask("a", "AAAA"));
    expect((await access.getTask("a"))?.title).toBe("AAAA");
    const raw = await readFile(path, "utf8");
    const rewritten = raw.replace('"AAAA"', '"BBBB"');
    expect(rewritten.length).toBe(raw.length);
    await writeFile(path, rewritten);
    expect((await access.getTask("a"))?.title).toBe("BBBB");
  });

  it("sees its own writes immediately", async () => {
    const access = new JsonTaskStateAccess(join(dir, "tasks.json"));
    await access.createTask(makeTask("a"));
    await access.listTasks();
    await access.patchTask("a", (task) => ({ ...task, title: "Patched" }));
    expect((await access.getTask("a"))?.title).toBe("Patched");
    await access.removeTask("a");
    expect(await access.listTasks()).toEqual([]);
  });

  it("falls back to empty state when the file is deleted after being cached", async () => {
    const path = join(dir, "tasks.json");
    const access = new JsonTaskStateAccess(path);
    await access.createTask(makeTask("a"));
    await access.listTasks();
    await rm(path);
    expect(await access.listTasks()).toEqual([]);
  });
});

describe("JsonWorkspaceBindingAccess parse cache", () => {
  it("parses once, hands out copies, and sees external and own writes", async () => {
    const path = join(dir, "workspace-bindings.json");
    const access = new JsonWorkspaceBindingAccess(path);
    const other = new JsonWorkspaceBindingAccess(path);
    await access.attachBinding(makeBinding("a"));

    const parse = vi.spyOn(JSON, "parse");
    const first = await access.listBindings();
    const second = await access.listBindings();
    await access.getBindingForTask("a");
    expect(parse).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    (first[0] as WorkspaceBinding).worktreePath = "/mutated";
    expect((await access.getBindingForTask("a"))?.worktreePath).toBe(undefined);
    parse.mockRestore();

    await other.attachBinding(makeBinding("b"));
    expect((await access.listBindings()).map((b) => b.taskId)).toEqual([
      "a",
      "b",
    ]);
    await access.removeBinding("a");
    expect((await access.listBindings()).map((b) => b.taskId)).toEqual(["b"]);
  });
});
