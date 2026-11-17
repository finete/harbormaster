// S5 (docs/harness-additions.md): a hook's "turn over" (`stop`) overrides a
// lingering 7501 `working`, whichever arrives first, until a `prompt` /
// `tool` boundary says a turn runs again. Wording-independent: the
// messages here deliberately do NOT match Claude's "still running" regex.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readingUnderTurnBoundary,
  trackBoundary,
  trackReport,
} from "../src/harness/turn-boundary.js";
import { type Core, createCore } from "../src/index.js";

const dirs: string[] = [];
const cores: Core[] = [];
afterEach(() => {
  for (const core of cores.splice(0)) core.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function claudeTask(): Promise<{ core: Core; taskId: string }> {
  const stateDir = mkdtempSync(join(tmpdir(), "harbormaster-turn-"));
  dirs.push(stateDir);
  const codeRoot = join(stateDir, "Code");
  mkdirSync(codeRoot);
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({ codeRoot }));
  const core = createCore({ stateDir });
  cores.push(core);
  const task = await core.commands.createTask({
    title: "Claude",
    initialPrompt: "",
    harness: "claude-code",
  });
  return { core, taskId: task.id };
}

const working = {
  state: "working" as const,
  message: "Waiting on the port-forward",
  pid: process.pid,
};

describe("readingUnderTurnBoundary", () => {
  it("turns working into idle only while the last boundary is stop", () => {
    const reading = { state: "working" as const, message: "x" };
    expect(readingUnderTurnBoundary(reading, "stop")).toEqual({
      state: "idle",
      message: "x",
    });
    expect(readingUnderTurnBoundary(reading, "prompt")).toEqual(reading);
    expect(readingUnderTurnBoundary(reading, "tool")).toEqual(reading);
    expect(readingUnderTurnBoundary(reading, undefined)).toEqual(reading);
    expect(readingUnderTurnBoundary({ state: "done" }, "stop")).toEqual({
      state: "done",
    });
  });

  it("forgets the boundary when a new process reports", () => {
    const stopped = trackBoundary(
      trackReport(undefined, 1, { state: "done" }),
      "stop",
    );
    expect(trackReport(stopped, 1, { state: "working" }).lastBoundary).toBe(
      "stop",
    );
    expect(
      trackReport(stopped, 2, { state: "working" }).lastBoundary,
    ).toBeUndefined();
  });
});

describe("reportTurnBoundary + reportPresence ordering", () => {
  it("stop, then working → idle (message kept)", async () => {
    const { core, taskId } = await claudeTask();
    await core.commands.reportPresence(taskId, {
      state: "done",
      pid: process.pid,
    });
    await core.commands.reportTurnBoundary(taskId, { kind: "stop" });
    await core.commands.reportPresence(taskId, working);
    const presence = await core.commands.getPresence(taskId);
    expect(presence.runningTurn).toBe(false);
    expect(presence.record?.status).toMatchObject({
      state: "idle",
      message: working.message,
    });
  });

  it("working, then stop → idle", async () => {
    const { core, taskId } = await claudeTask();
    await core.commands.reportTurnBoundary(taskId, { kind: "prompt" });
    await core.commands.reportPresence(taskId, working);
    expect((await core.commands.getPresence(taskId)).runningTurn).toBe(true);
    await core.commands.reportTurnBoundary(taskId, { kind: "stop" });
    const presence = await core.commands.getPresence(taskId);
    expect(presence.runningTurn).toBe(false);
    expect(presence.record?.status).toMatchObject({
      state: "idle",
      message: working.message,
    });
  });

  it("stop, then prompt, then working → working", async () => {
    const { core, taskId } = await claudeTask();
    await core.commands.reportPresence(taskId, {
      state: "done",
      pid: process.pid,
    });
    await core.commands.reportTurnBoundary(taskId, { kind: "stop" });
    await core.commands.reportTurnBoundary(taskId, { kind: "prompt" });
    await core.commands.reportPresence(taskId, working);
    const presence = await core.commands.getPresence(taskId);
    expect(presence.runningTurn).toBe(true);
    expect(presence.record?.status?.state).toBe("working");
  });

  it("stop, working, then a tool boundary → working again", async () => {
    const { core, taskId } = await claudeTask();
    await core.commands.reportPresence(taskId, {
      state: "done",
      pid: process.pid,
    });
    await core.commands.reportTurnBoundary(taskId, { kind: "stop" });
    await core.commands.reportPresence(taskId, working);
    expect((await core.commands.getPresence(taskId)).runningTurn).toBe(false);
    await core.commands.reportTurnBoundary(taskId, { kind: "tool" });
    expect((await core.commands.getPresence(taskId)).runningTurn).toBe(true);
  });

  it("a boundary with no report yet records nothing", async () => {
    const { core, taskId } = await claudeTask();
    await core.commands.reportTurnBoundary(taskId, { kind: "stop" });
    expect((await core.commands.getPresence(taskId)).record).toBeUndefined();
  });
});
