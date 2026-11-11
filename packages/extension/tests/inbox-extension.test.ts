import {
  TRUST_LINE as CORE_TRUST_LINE,
  type FormattedInboxMessage,
} from "@harbormaster/core";
import { describe, expect, it } from "vitest";
import {
  formatInboxMessageDisplay,
  type InboxDrainDeps,
  InboxDrainer,
  isPaneSession,
  messageText,
  renderInboxMessage,
  TRUST_LINE,
} from "../src/index.js";

it("the self-contained copy of the trust line matches core's", () => {
  expect(TRUST_LINE).toBe(CORE_TRUST_LINE);
});

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

function formatted(
  overrides: { messageId?: string; deliverAs?: "steer" | "followUp" } = {},
): FormattedInboxMessage {
  return {
    customType: "harbormaster-message",
    content: [{ type: "text", text: "hello" }],
    text: "hello",
    details: {
      messageId: overrides.messageId ?? "m-1",
      route: "parent-to-child",
      sender: { kind: "task", taskId: "p-1" },
      senderLabel: "Parent work",
    },
    deliverAs: overrides.deliverAs ?? "followUp",
  };
}

describe("isPaneSession", () => {
  const base = { sessionId: "s1", sessionPath: "/s/a.jsonl" };
  it("accepts the pane's own session by id or by file, and anything without expectations", () => {
    expect(
      isPaneSession({
        ...base,
        expectedSessionId: "s1",
        expectedSessionPath: undefined,
      }),
    ).toBe(true);
    expect(
      isPaneSession({
        ...base,
        expectedSessionId: "other",
        expectedSessionPath: "/s/a.jsonl",
      }),
    ).toBe(true);
    expect(
      isPaneSession({
        ...base,
        expectedSessionId: undefined,
        expectedSessionPath: undefined,
      }),
    ).toBe(true);
  });

  it("rejects a nested session that inherited the env", () => {
    expect(
      isPaneSession({
        ...base,
        expectedSessionId: "parent",
        expectedSessionPath: undefined,
      }),
    ).toBe(false);
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
      send: (...args) => {
        sent.push(args);
      },
    };
    return { drainer: new InboxDrainer(deps), sent, claims };
  }

  it("triggers a turn when idle", async () => {
    const { drainer, sent } = setup({
      claim: async () => [formatted({ deliverAs: "steer" })],
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
        formatted({ messageId: "m-1" }),
        formatted({ messageId: "m-2" }),
        formatted({ messageId: "m-3" }),
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
          formatted({ messageId: "a", deliverAs: "steer" }),
          formatted({ messageId: "b", deliverAs: "followUp" }),
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
        return [formatted()];
      },
    });
    await drainer.drain();
    expect(sent).toHaveLength(0);
    await drainer.drain();
    expect(sent).toHaveLength(1);
  });
});
