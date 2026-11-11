// `harbormaster mcp`: an MCP stdio server exposing every entry of core's
// tool catalog (decision #18). Pure forwarding: each call goes over the
// app's local socket with the caller identity taken from this process's
// environment (the per-session config the harness adapter writes), never
// from the tool arguments.

import {
  callTool,
  HarbormasterNotRunningError,
  type InboxClaimDetails,
  NOT_RUNNING_MESSAGE,
  TOOL_CATALOG,
  type ToolCaller,
} from "@harbormaster/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const CLI_VERSION = "0.0.1";

export interface McpServerOptions {
  socketPath: string;
  caller: ToolCaller;
}

/** Builds the MCP server (not yet connected to a transport). */
export function createMcpServer(options: McpServerOptions): Server {
  const server = new Server(
    { name: "harbormaster", version: CLI_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Harbormaster tools for this task: report_status (final outcome), launch_task / subtask_status (background tasks), find_tasks / send_to_task (message other tasks).",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_CATALOG.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      try {
        const result = await callTool(
          options.socketPath,
          name,
          (args ?? {}) as Record<string, unknown>,
          options.caller,
        );
        const content: CallToolResult["content"] = [
          { type: "text", text: result.text },
        ];
        if (name === "inbox_claim") {
          for (const message of (result.details as InboxClaimDetails)
            .messages) {
            for (const block of message.content) {
              if (block.type === "image") {
                content.push({
                  type: "image",
                  data: block.data,
                  mimeType: block.mimeType,
                });
              }
            }
          }
        }
        return { content };
      } catch (error) {
        const text =
          error instanceof HarbormasterNotRunningError
            ? NOT_RUNNING_MESSAGE
            : error instanceof Error
              ? error.message
              : String(error);
        return { content: [{ type: "text", text }], isError: true };
      }
    },
  );

  return server;
}

/** Serves MCP on stdin/stdout until the client closes the stream. */
export async function serveMcpOverStdio(
  options: McpServerOptions,
): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
}
