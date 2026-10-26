// Transcript rendering for delivered `harbormaster-message` entries (see
// /docs/task-messaging.md "Extension"): the header line naming the sender
// and route is shown distinctly (accent, bold), the body below it as plain
// text. Collapsed, the agent-facing boilerplate after the message (trust
// line, reply guidance) is hidden; expanded shows everything. Kept simple on
// purpose; `formatInboxMessageDisplay` is pure so it is testable without a
// TUI, and `index.ts` wires `renderInboxMessage` via
// `pi.registerMessageRenderer`.

import { Box, Text } from "@earendil-works/pi-tui";
import { TRUST_LINE } from "./inbox-delivery.js";

/** The subset of pi's `Theme` the renderer needs. */
export interface MessageRendererTheme {
  fg(token: "accent" | "dim", text: string): string;
  bold(text: string): string;
  bg(token: "customMessageBg", text: string): string;
}

/** Structural subset of pi's `CustomMessage` the renderer reads. */
export interface RenderableMessage {
  content: string | ReadonlyArray<{ type: string; text?: string }>;
}

/** The text of a message's text blocks, in order (image blocks are not shown inline). */
export function messageText(message: RenderableMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/** Splits the stored text into its header line and body; collapsed drops the trailing boilerplate (trust line onward). */
export function formatInboxMessageDisplay(
  text: string,
  expanded: boolean,
): { header: string; body: string } {
  const newline = text.indexOf("\n");
  const header = newline === -1 ? text : text.slice(0, newline);
  let body = newline === -1 ? "" : text.slice(newline + 1).trim();
  if (!expanded) {
    const trust = body.indexOf(TRUST_LINE);
    if (trust !== -1) body = body.slice(0, trust).trim();
  }
  return { header, body };
}

/** The `pi.registerMessageRenderer("harbormaster-message", ...)` renderer. */
export function renderInboxMessage(
  message: RenderableMessage,
  options: { expanded: boolean; outputPad: number },
  theme: MessageRendererTheme,
): Box {
  const { header, body } = formatInboxMessageDisplay(
    messageText(message),
    options.expanded,
  );
  const lines = [theme.fg("accent", theme.bold(header))];
  if (body) lines.push(body);
  const box = new Box(options.outputPad, 1, (text) =>
    theme.bg("customMessageBg", text),
  );
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}
