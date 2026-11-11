// The local tool socket's server half (decision #18, docs/release-plan.md
// R5). Hosted by the automation host (the Electron app today, a daemon
// later): it dispatches catalog calls to the command API and streams inbox
// doorbells. Transport only: every rule lives behind `CoreCommands`.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { CoreCommands } from "../contracts/commands.js";
import { dispatchToolCall } from "../tools/catalog.js";
import {
  LineSplitter,
  type SocketRequest,
  type SocketResponse,
} from "./protocol.js";

export interface ToolSocketServerOptions {
  socketPath: string;
  commands: CoreCommands;
  /** Called after every tool call (success or failure), e.g. to log or nudge a pass. */
  onCall?: (tool: string, outcome: { ok: boolean; error?: string }) => void;
}

export interface ToolSocketServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** Whether something already answers on `socketPath` (another live host). */
function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    const done = (live: boolean): void => {
      probe.destroy();
      resolve(live);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

function write(socket: Socket, response: SocketResponse): void {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(response)}\n`);
}

/**
 * Listens on `socketPath` (a stale socket file from a crashed host is
 * replaced; a live one is never stolen: that rejects instead).
 */
export async function startToolSocketServer(
  options: ToolSocketServerOptions,
): Promise<ToolSocketServer> {
  const { socketPath, commands } = options;
  mkdirSync(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) {
    if (await socketIsLive(socketPath)) {
      throw new Error(
        `another Harbormaster instance already listens on ${socketPath}`,
      );
    }
    rmSync(socketPath, { force: true });
  }

  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    const unsubscribers: Array<() => void> = [];
    const splitter = new LineSplitter();
    socket.on("data", (chunk: string) => {
      for (const line of splitter.push(chunk)) {
        let request: SocketRequest;
        try {
          request = JSON.parse(line) as SocketRequest;
        } catch {
          write(socket, { id: 0, ok: false, error: "malformed request" });
          continue;
        }
        void handle(request, socket, unsubscribers);
      }
    });
    const cleanup = (): void => {
      sockets.delete(socket);
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  async function handle(
    request: SocketRequest,
    socket: Socket,
    unsubscribers: Array<() => void>,
  ): Promise<void> {
    const id = request?.id ?? 0;
    try {
      switch (request?.method) {
        case "ping":
          write(socket, { id, ok: true, result: { text: "pong" } });
          return;
        case "watch-inbox": {
          const taskId = request.caller?.taskId;
          if (!taskId) throw new Error("watch-inbox needs a task caller");
          unsubscribers.push(
            commands.subscribeInbox(taskId, () =>
              write(socket, { id, event: "inbox" }),
            ),
          );
          write(socket, { id, ok: true, result: { text: "watching" } });
          return;
        }
        case "call": {
          const result = await dispatchToolCall(
            commands,
            request.tool,
            request.args ?? {},
            request.caller ?? {},
          );
          options.onCall?.(request.tool, { ok: true });
          write(socket, { id, ok: true, result });
          return;
        }
        default:
          throw new Error("unknown method");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (request?.method === "call") {
        options.onCall?.(request.tool, { ok: false, error: message });
      }
      write(socket, { id, ok: false, error: message });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}
