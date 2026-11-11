// The local tool socket's client half: what `harbormaster` (CLI + MCP
// server) uses to reach the running app. Never touches state files: every
// call goes over the socket, and "nothing listening" surfaces as
// `HarbormasterNotRunningError` so every client prints the same
// "Harbormaster is not running".

import { connect } from "node:net";
import type { ToolCaller, ToolResult } from "../tools/catalog.js";
import {
  DEFAULT_STATE_DIR,
  resolveSocketPath,
} from "../utilities/state-paths.js";
import {
  LineSplitter,
  NOT_RUNNING_MESSAGE,
  type SocketRequest,
  type SocketResponse,
} from "./protocol.js";

export class HarbormasterNotRunningError extends Error {
  constructor() {
    super(NOT_RUNNING_MESSAGE);
    this.name = "HarbormasterNotRunningError";
  }
}

const NOT_RUNNING_CODES = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);

/** The socket a client in this environment talks to: `HARBORMASTER_SOCKET`, else derived from the state dir. */
export function socketPathFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.HARBORMASTER_SOCKET ||
    resolveSocketPath(env.HARBORMASTER_STATE_DIR || DEFAULT_STATE_DIR)
  );
}

/**
 * The caller identity of this process, from the launch spec's environment
 * only. A nested agent session inheriting a task's environment (a subagent
 * child with its own Pi session, detected by `PI_SESSION_ID` differing from
 * the task's `HARBORMASTER_SESSION_ID`) is NOT the task: it calls as a
 * plain session, which core routes through user approval.
 */
export function callerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ToolCaller {
  const taskId = env.HARBORMASTER_TASK_ID || undefined;
  const sessionId = env.HARBORMASTER_SESSION_ID || undefined;
  const actualSession = env.PI_SESSION_ID || undefined;
  const nested =
    taskId !== undefined &&
    sessionId !== undefined &&
    actualSession !== undefined &&
    actualSession !== sessionId;
  return {
    ...(taskId && !nested ? { taskId } : {}),
    ...(nested ? { sessionId: actualSession } : sessionId ? { sessionId } : {}),
    cwd,
  };
}

let nextId = 1;

/** A request before the client assigns its id. */
export type UnsentSocketRequest = SocketRequest extends infer R
  ? R extends SocketRequest
    ? Omit<R, "id">
    : never
  : never;

/** Sends one request and resolves its response (rejects `HarbormasterNotRunningError` when nothing listens). */
export function sendSocketRequest(
  socketPath: string,
  request: UnsentSocketRequest,
  timeoutMs = 120_000,
): Promise<SocketResponse> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    const splitter = new LineSplitter();
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() => reject(new Error("Harbormaster did not answer in time"))),
      timeoutMs,
    );
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ ...request, id })}\n`);
    });
    socket.on("data", (chunk: string) => {
      for (const line of splitter.push(chunk)) {
        let response: SocketResponse;
        try {
          response = JSON.parse(line) as SocketResponse;
        } catch {
          continue;
        }
        if (response.id === id && !("event" in response)) {
          finish(() => resolve(response));
        }
      }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code && NOT_RUNNING_CODES.has(error.code)
            ? new HarbormasterNotRunningError()
            : error,
        ),
      );
    });
    socket.once("close", () => {
      finish(() => reject(new HarbormasterNotRunningError()));
    });
  });
}

/** Runs one catalog tool through the app; rejects with the tool's own error message. */
export async function callTool(
  socketPath: string,
  tool: string,
  args: Record<string, unknown>,
  caller: ToolCaller,
): Promise<ToolResult> {
  const response = await sendSocketRequest(socketPath, {
    method: "call",
    tool,
    args,
    caller,
  });
  if ("event" in response) throw new Error("unexpected event");
  if (!response.ok) throw new Error(response.error);
  return response.result;
}
