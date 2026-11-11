// Wire protocol of the local tool socket (decision #18, docs/release-plan.md
// R5): newline-delimited JSON over a unix socket in the state dir. Plain
// data only (no Electron, no process handles), so a future daemon can serve
// the very same protocol. One request per line, answered by one response
// line with the same `id`; `watch-inbox` instead streams `event` lines until
// the client disconnects.

import type { ToolCaller, ToolResult } from "../tools/catalog.js";

/** Printed by every client when nothing listens on the socket. */
export const NOT_RUNNING_MESSAGE = "Harbormaster is not running";

export type RequestId = number | string;

/** Run one catalog tool (see `tools/catalog.ts`). */
export interface ToolCallRequest {
  id: RequestId;
  method: "call";
  tool: string;
  args?: Record<string, unknown>;
  caller: ToolCaller;
}

/** Ring the caller whenever its task's inbox changes; streams `inbox` events. */
export interface WatchInboxRequest {
  id: RequestId;
  method: "watch-inbox";
  caller: ToolCaller;
}

/** Liveness check: answered with `{ ok: true, result: { text: "pong" } }`. */
export interface PingRequest {
  id: RequestId;
  method: "ping";
}

export type SocketRequest = ToolCallRequest | WatchInboxRequest | PingRequest;

export type SocketResponse =
  | { id: RequestId; ok: true; result: ToolResult }
  | { id: RequestId; ok: false; error: string }
  | { id: RequestId; event: "inbox" };

/** Splits a stream of chunks into complete lines (the trailing partial line is kept). */
export class LineSplitter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.filter((line) => line.trim().length > 0);
  }
}
