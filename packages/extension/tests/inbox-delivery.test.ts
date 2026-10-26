import type { TaskMessage } from "@harbormaster/core";
import { describe, expect, it } from "vitest";
import {
  buildInboxHeader,
  buildInboxMessageContent,
  buildInboxMessageText,
  type InboxDrainDeps,
  InboxDrainer,
  TRUST_LINE,
} from "../src/inbox-delivery.js";

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
      "Reply with harbormaster_send_to_task to c-9 only if your brief or context settles it; product or scope decisions go to the user (ask them, then relay the answer).",
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

describe("InboxDrainer", () => {
  type Sent = Parameters<InboxDrainDeps["send"]>;

  function setup(
    options: { idle?: () => boolean; claim?: InboxDrainDeps["claim"] } = {},
  ) {
    const sent: Sent[] = [];
    const claims: Array<{ idle: boolean }> = [];
    const deps: InboxDrainDeps = {
      claim:
        options.claim ??
        (async (o) => {
          claims.push(o);
          return [];
        }),
      isIdle: options.idle ?? (() => true),
      readAttachment: async () => ({ base64: "" }),
      send: (...args) => {
        sent.push(args);
      },
    };
    return { drainer: new InboxDrainer(deps), sent, claims };
  }

  it("triggers a turn when idle", async () => {
    const { drainer, sent } = setup({
      claim: async () => [message({ deliveredMode: "steer" })],
    });
    await drainer.drain();
    expect(sent).toHaveLength(1);
    const [payload, options] = sent[0] as Sent;
    expect(options).toEqual({ triggerTurn: true });
    expect(payload.customType).toBe("harbormaster-message");
    expect(payload.display).toBe(true);
    expect(payload.details).toEqual({
      messageId: "m-1",
      route: "parent-to-child",
      sender: { kind: "task", taskId: "p-1" },
      senderLabel: "Parent work",
    });
  });

  it("an idle batch starts exactly one turn: earlier messages are appended, the last triggers", async () => {
    const { drainer, sent } = setup({
      claim: async () => [
        message({ id: "m-1" }),
        message({ id: "m-2" }),
        message({ id: "m-3" }),
      ],
    });
    await drainer.drain();
    expect(sent.map(([, options]) => options)).toEqual([
      { triggerTurn: false },
      { triggerTurn: false },
      { triggerTurn: true },
    ]);
  });

  it("delivers as the resolved mode while streaming, and claims with idle=false", async () => {
    const seen: boolean[] = [];
    const { drainer, sent } = setup({
      idle: () => false,
      claim: async ({ idle }) => {
        seen.push(idle);
        return [
          message({ id: "a", deliveredMode: "steer" }),
          message({ id: "b", deliveredMode: "followUp" }),
        ];
      },
    });
    await drainer.drain();
    expect(seen).toEqual([false]);
    expect(sent.map(([, options]) => options)).toEqual([
      { deliverAs: "steer" },
      { deliverAs: "followUp" },
    ]);
  });

  it("serializes drains: overlapping triggers never claim concurrently and coalesce into one more pass", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { drainer } = setup({
      claim: async () => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (calls === 1) await gate;
        inFlight -= 1;
        return [];
      },
    });
    const first = drainer.drain();
    const second = drainer.drain();
    const third = drainer.drain();
    release();
    await Promise.all([first, second, third]);
    expect(maxInFlight).toBe(1);
    expect(calls).toBe(2);
  });

  it("swallows claim errors and drains again on the next trigger", async () => {
    let calls = 0;
    const { drainer, sent } = setup({
      claim: async () => {
        calls += 1;
        if (calls === 1) throw new Error("locked");
        return [message()];
      },
    });
    await drainer.drain();
    expect(sent).toHaveLength(0);
    await drainer.drain();
    expect(sent).toHaveLength(1);
  });
});
