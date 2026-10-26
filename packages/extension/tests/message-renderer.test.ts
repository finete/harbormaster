import { describe, expect, it } from "vitest";
import { TRUST_LINE } from "../src/inbox-delivery.js";
import {
  formatInboxMessageDisplay,
  messageText,
  renderInboxMessage,
} from "../src/message-renderer.js";

const text = `[Message from your parent task "P" (p-1)]\n\nHello\n\n${TRUST_LINE}`;

describe("formatInboxMessageDisplay", () => {
  it("splits the header and hides the boilerplate when collapsed", () => {
    expect(formatInboxMessageDisplay(text, false)).toEqual({
      header: '[Message from your parent task "P" (p-1)]',
      body: "Hello",
    });
  });

  it("keeps everything when expanded", () => {
    expect(formatInboxMessageDisplay(text, true).body).toContain(TRUST_LINE);
  });
});

describe("messageText", () => {
  it("joins text blocks and ignores images", () => {
    expect(
      messageText({
        content: [
          { type: "text", text: "a" },
          { type: "image" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
    expect(messageText({ content: "plain" })).toBe("plain");
  });
});

describe("renderInboxMessage", () => {
  it("renders a styled header and the body", () => {
    const theme = {
      fg: (token: string, value: string) => `<${token}>${value}</${token}>`,
      bold: (value: string) => `**${value}**`,
      bg: (_token: "customMessageBg", value: string) => value,
    };
    const box = renderInboxMessage(
      { content: [{ type: "text", text }] },
      { expanded: false, outputPad: 1 },
      theme,
    );
    const lines = box.render(80).join("\n");
    expect(lines).toContain("[Message from your parent task");
    expect(lines).toContain("Hello");
    expect(lines).not.toContain("not from the user");
  });
});
