// Wiring of the extension entry point against a fake pi ExtensionAPI:
// presence follows the whole agent loop (agent_start/agent_end, never
// per-turn), and the session is named after its task (pi-home's
// setSessionName). Real presence/task files in a temp state dir.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  JsonTaskStateAccess,
  resolveStatePaths,
  SessionPresenceAccess,
} from "@harbormaster/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import harbormasterExtension from "../src/index.js";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

function fakePi() {
  const handlers = new Map<string, Handler>();
  let sessionName: string | undefined;
  const renames: string[] = [];
  const api = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    getSessionName: () => sessionName,
    setSessionName: (name: string) => {
      sessionName = name;
      renames.push(name);
    },
  } as unknown as ExtensionAPI;
  return { api, handlers, renames };
}

function fakeCtx(sessionPath: string): ExtensionContext {
  return {
    hasUI: true,
    sessionManager: {
      getSessionFile: () => sessionPath,
      getSessionId: () => "session-1",
    },
    ui: {
      setTitle: () => {},
      setWidget: () => {},
      theme: { fg: (_token: string, text: string) => text },
    },
  } as unknown as ExtensionContext;
}

describe("extension wiring", () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harbormaster-ext-wiring-"));
    process.env.HARBORMASTER_TASK_ID = "task-1";
    process.env.HARBORMASTER_STATE_DIR = dir;
    const paths = resolveStatePaths(dir);
    await new JsonTaskStateAccess(
      paths.tasksFile,
      paths.tasksLockFile,
    ).createTask({
      id: "task-1",
      kind: "task",
      state: "dev",
      title: "Fix the login bug",
      initialPrompt: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      stateChangedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  afterEach(async () => {
    process.env = { ...saved };
    await rm(dir, { recursive: true, force: true });
  });

  it("tracks running state across the whole agent loop, not individual turns", async () => {
    const pi = fakePi();
    harbormasterExtension(pi.api);
    expect(pi.handlers.has("turn_start")).toBe(false);
    expect(pi.handlers.has("turn_end")).toBe(false);

    const ctx = fakeCtx(join(dir, "session.jsonl"));
    await pi.handlers.get("session_start")?.({}, ctx);
    const presence = new SessionPresenceAccess(
      resolveStatePaths(dir).presenceDir,
    );

    await pi.handlers.get("agent_start")?.({}, ctx);
    expect((await presence.read("task-1"))?.runningTurn).toBe(true);
    await pi.handlers.get("agent_end")?.({}, ctx);
    expect((await presence.read("task-1"))?.runningTurn).toBe(false);

    await pi.handlers.get("session_shutdown")?.({}, ctx);
  });

  it("names the session after its task once (no rename when already named)", async () => {
    const pi = fakePi();
    harbormasterExtension(pi.api);
    const ctx = fakeCtx(join(dir, "session.jsonl"));

    await pi.handlers.get("session_start")?.({}, ctx);
    await pi.handlers.get("session_start")?.({}, ctx);

    expect(pi.renames).toEqual(["Fix the login bug"]);
    await pi.handlers.get("session_shutdown")?.({}, ctx);
  });
});
