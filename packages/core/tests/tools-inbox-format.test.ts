import { describe, expect, it } from "vitest";
import type { TaskMessage } from "../src/contracts/messaging.js";
import {
  buildInboxHeader,
  buildInboxMessageContent,
  buildInboxMessageText,
  formatInboxMessage,
  TRUST_LINE,
} from "../src/tools/inbox-format.js";

function message(overrides: Partial<TaskMessage> = {}): TaskMessage {
  return {
    id: "m-1",
    sender: { kind: "task", taskId: "p-1" },
    senderLabel: "Parent work",
    targetTaskId: "c-1",
    route: "parent-to-child",
    text: "Use the new API",
    requestedMode: "steer",
    attachments: [],
    status: "delivered",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildInboxHeader", () => {
  it("names the parent for parent-to-child", () => {
    expect(buildInboxHeader(message())).toBe(
      '[Message from your parent task "Parent work" (p-1)]',
    );
  });

  it("calls a child's message a question", () => {
    expect(
      buildInboxHeader(
        message({
          route: "child-to-parent",
          sender: { kind: "task", taskId: "c-9" },
          senderLabel: "Child work",
        }),
      ),
    ).toBe('[Question from your child task "Child work" (c-9)]');
  });

  it("marks approved task and session messages", () => {
    expect(
      buildInboxHeader(
        message({
          route: "approval",
          sender: { kind: "task", taskId: "x-1" },
          senderLabel: "Sibling",
        }),
      ),
    ).toBe('[Message from task "Sibling" (x-1), approved by the user]');
    expect(
      buildInboxHeader(
        message({
          route: "approval",
          sender: { kind: "session", cwd: "/code/app" },
          senderLabel: "Pi session in /code/app",
        }),
      ),
    ).toBe("[Message from a Pi session (/code/app), approved by the user]");
  });

  it("labels receipts as Harbormaster", () => {
    expect(
      buildInboxHeader(
        message({ route: "receipt", sender: { kind: "harbormaster" } }),
      ),
    ).toBe("[Harbormaster]");
  });
});

describe("buildInboxMessageText", () => {
  it("is header, text and the trust line", () => {
    expect(buildInboxMessageText(message())).toBe(
      `[Message from your parent task "Parent work" (p-1)]\n\nUse the new API\n\n${TRUST_LINE}`,
    );
  });

  it("lists attachments' copied absolute paths before the trust line", () => {
    const text = buildInboxMessageText(
      message({
        attachments: [
          { path: "/state/a.png", originalPath: "/tmp/a.png", bytes: 1 },
          { path: "/state/b.txt", originalPath: "/tmp/b.txt", bytes: 1 },
        ],
      }),
    );
    expect(text).toContain("Attachments:\n/state/a.png\n/state/b.txt");
    expect(text.indexOf("Attachments:")).toBeLessThan(text.indexOf(TRUST_LINE));
  });

  it("gives the parent reply guidance for a child's question", () => {
    const text = buildInboxMessageText(
      message({
        route: "child-to-parent",
        sender: { kind: "task", taskId: "c-9" },
        senderLabel: "Child work",
        text: "Which DB?",
      }),
    );
    expect(text).toContain(TRUST_LINE);
    expect(text).toContain(
      "Reply with the send_to_task tool to c-9 only if your brief or context settles it; product or scope decisions go to the user (ask them, then relay the answer).",
    );
    expect(buildInboxMessageText(message())).not.toContain("Reply with");
  });

  it("omits the trust line for receipts", () => {
    const text = buildInboxMessageText(
      message({
        route: "receipt",
        sender: { kind: "harbormaster" },
        text: "Your message was rejected.",
      }),
    );
    expect(text).toBe("[Harbormaster]\n\nYour message was rejected.");
  });
});

describe("buildInboxMessageContent", () => {
  const png = {
    path: "/state/a.png",
    originalPath: "/tmp/a.png",
    mimeType: "image/png",
    bytes: 3,
  };

  it("inlines image attachments after the text block", async () => {
    const blocks = await buildInboxMessageContent(
      message({
        attachments: [
          png,
          { ...png, path: "/state/n.txt", mimeType: "text/plain" },
        ],
      }),
      async (id, index) => {
        expect(id).toBe("m-1");
        expect(index).toBe(0);
        return { mimeType: "image/png", base64: "AAAA" };
      },
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[1]).toEqual({
      type: "image",
      data: "AAAA",
      mimeType: "image/png",
    });
  });

  it("skips pruned images and falls back to path-only when a read fails", async () => {
    const pruned = await buildInboxMessageContent(
      message({
        attachments: [{ ...png, prunedAt: "2026-02-01T00:00:00.000Z" }],
      }),
      async () => {
        throw new Error("must not be read");
      },
    );
    expect(pruned).toHaveLength(1);
    const failed = await buildInboxMessageContent(
      message({ attachments: [png] }),
      async () => {
        throw new Error("gone");
      },
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("/state/a.png"),
    });
  });
});

describe("formatInboxMessage", () => {
  it("bundles content, text, details and the resolved delivery mode", async () => {
    const formatted = await formatInboxMessage(
      message({ deliveredMode: "steer" }),
      async () => ({ base64: "" }),
    );
    expect(formatted.customType).toBe("harbormaster-message");
    expect(formatted.deliverAs).toBe("steer");
    expect(formatted.text).toBe(buildInboxMessageText(message()));
    expect(formatted.content).toEqual([{ type: "text", text: formatted.text }]);
    expect(formatted.details).toEqual({
      messageId: "m-1",
      route: "parent-to-child",
      sender: { kind: "task", taskId: "p-1" },
      senderLabel: "Parent work",
    });
  });

  it("defaults an unresolved mode to followUp", async () => {
    const formatted = await formatInboxMessage(message(), async () => ({
      base64: "",
    }));
    expect(formatted.deliverAs).toBe("followUp");
  });
});
