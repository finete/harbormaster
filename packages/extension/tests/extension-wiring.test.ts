// The inbox extension wired against a fake pi ExtensionAPI and the real
// local socket (what the app hosts) over a temp state dir: the pane's own
// session claims and delivers its inbox (idle -> a new turn, streaming ->
// steer; followUps wait for the turn boundary), registers the per-session
// MCP server, and a nested session that inherited the env stands down.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type Core,
  createCore,
  PiHarnessAdapter,
  resolveSocketPath,
  startToolSocketServer,
  type ToolSocketServer,
} from "@harbormaster/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import harbormasterInboxExtension from "../src/index.js";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

interface Sent {
  message: { customType: string; content: Array<{ text?: string }> };
  options: unknown;
}

function fakePi() {
  const handlers = new Map<string, Handler>();
  const sent: Sent[] = [];
  const mcp: Array<{ name: string; config: unknown }> = [];
  const renderers: string[] = [];
  const api = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    registerMessageRenderer: (customType: string) => {
      renderers.push(customType);
    },
    registerMcpServer: (name: string, config: unknown) => {
      mcp.push({ name, config });
    },
    sendMessage: (message: Sent["message"], options: unknown) => {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const emit = (event: string, ctx: ExtensionContext) =>
    handlers.get(event)?.({}, ctx);
  return { api, handlers, sent, mcp, renderers, emit };
}

function fakeCtx(
  sessionId: string,
  agent: { idle: boolean },
): ExtensionContext {
  return {
    isIdle: () => agent.idle,
    sessionManager: {
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
      getSessionId: () => sessionId,
    },
  } as unknown as ExtensionContext;
}

let stateDir: string;
let core: Core;
let server: ToolSocketServer;
let parentId: string;
let childId: string;
const saved = { ...process.env };

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "hm-ext-"));
  core = createCore({
    stateDir,
    harness: new PiHarnessAdapter({ stateDir, isAlive: () => true }),
  });
  const socketPath = resolveSocketPath(stateDir);
  server = await startToolSocketServer({ socketPath, commands: core.commands });
  parentId = (
    await core.commands.launchTask({
      relation: "standalone",
      title: "Parent work",
      prompt: "p",
      repository: { none: true },
    })
  ).id;
  childId = (
    await core.commands.launchTask({
      relation: "child",
      fromTaskId: parentId,
      title: "Child work",
      prompt: "p",
      repository: { none: true },
    })
  ).id;
  process.env.HARBORMASTER_TASK_ID = childId;
  process.env.HARBORMASTER_SOCKET = socketPath;
  process.env.HARBORMASTER_SESSION_ID = "pane-session";
  delete process.env.HARBORMASTER_SESSION_PATH;
  process.env.HARBORMASTER_MCP_SERVER = JSON.stringify({
    command: "/abs/harbormaster",
    args: ["mcp"],
  });
});

afterEach(async () => {
  process.env = { ...saved };
  await server.close();
  await rm(stateDir, { recursive: true, force: true });
});

function send(text: string, mode: "steer" | "followUp") {
  return core.commands.sendTaskMessage({
    from: { kind: "task", taskId: parentId },
    targetTaskId: childId,
    text,
    mode,
  });
}

describe("inbox extension wiring", () => {
  it("does nothing outside a Harbormaster task session", () => {
    delete process.env.HARBORMASTER_TASK_ID;
    const pi = fakePi();
    harbormasterInboxExtension(pi.api);
    expect(pi.handlers.size).toBe(0);
    expect(pi.renderers).toEqual([]);
  });

  it("delivers to the pane's own session: idle starts a turn, streaming steers, followUps wait for the boundary", async () => {
    const pi = fakePi();
    harbormasterInboxExtension(pi.api);
    expect(pi.renderers).toEqual(["harbormaster-message"]);
    const agent = { idle: true };
    const ctx = fakeCtx("pane-session", agent);
    await pi.emit("session_start", ctx);
    expect(pi.mcp).toEqual([
      {
        name: "harbormaster",
        config: { command: "/abs/harbormaster", args: ["mcp"] },
      },
    ]);

    // Idle: the doorbell rings, the message starts a turn.
    await send("first", "steer");
    await expect.poll(() => pi.sent.length, { timeout: 5000 }).toBe(1);
    expect(pi.sent[0]?.options).toEqual({ triggerTurn: true });
    expect(pi.sent[0]?.message.customType).toBe("harbormaster-message");
    expect(pi.sent[0]?.message.content[0]?.text).toContain("first");

    // Streaming: a steer lands mid-turn; a followUp waits.
    agent.idle = false;
    await send("second", "steer");
    await expect.poll(() => pi.sent.length, { timeout: 5000 }).toBe(2);
    expect(pi.sent[1]?.options).toEqual({ deliverAs: "steer" });
    await send("third", "followUp");
    // The doorbell rang but nothing claimable while streaming: give the
    // drain a moment, then check nothing was sent.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pi.sent).toHaveLength(2);

    agent.idle = true;
    await pi.emit("agent_end", ctx);
    await expect.poll(() => pi.sent.length, { timeout: 5000 }).toBe(3);
    expect(pi.sent[2]?.message.content[0]?.text).toContain("third");
    await pi.emit("session_shutdown", ctx);
  });

  it("a nested session inheriting the env neither claims nor registers tools", async () => {
    const pi = fakePi();
    harbormasterInboxExtension(pi.api);
    const ctx = fakeCtx("nested-child-session", { idle: true });
    await pi.emit("session_start", ctx);
    expect(pi.mcp).toEqual([]);
    await send("for the pane only", "steer");
    await pi.emit("agent_end", ctx);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pi.sent).toEqual([]);
    const pending = await core.commands.listTasksWithPendingMessages();
    expect(pending).toContain(childId);
  });
});
