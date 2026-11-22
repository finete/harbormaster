// Queued delivery through a harness's deliver command (Codex `codex queue`,
// docs/harness-additions.md X5): pending until the agent's next turn
// confirms it, typed after QUEUE_CONFIRM_MS at its prompt otherwise; plus
// the OSC 9 note that becomes a `done` report's message (X4) and the
// typed form of a Codex skill command.

import { REPORT_STATUS_REMINDER, type TaskMessage } from "@harbormaster/core";
import { describe, expect, it } from "vitest";
import {
  deliverableMessages,
  HarnessDeliveries,
  QUEUE_CONFIRM_MS,
  queueTextFor,
} from "../src/main/harness-delivery";
import {
  DoneMessageJoiner,
  Osc9Splitter,
  osc9Message,
} from "../src/main/osc9-notifications";
import { typedCommandText, typeText } from "../src/main/review-transport";

const COMMAND = { command: "codex", args: ["queue"] };

function harness(options: { run?: boolean; claimable?: number } = {}) {
  let now = 1_000;
  const events: string[] = [];
  const claims: string[][] = [];
  const typed: string[] = [];
  const userInputs: string[] = [];
  const runs: string[][] = [];
  let claimable = options.claimable ?? 1;
  const deliveries = new HarnessDeliveries({
    now: () => now,
    run: async (command) => {
      runs.push(command.args);
      return options.run ?? true;
    },
    claim: async (_taskId, ids) => {
      claims.push(ids);
      const n = claimable;
      claimable = 0;
      return n;
    },
    type: async (_taskId, text) => {
      typed.push(text);
      return true;
    },
    recordUserInput: (taskId) => userInputs.push(taskId),
    onEvent: (event) => events.push(event),
  });
  return {
    deliveries,
    events,
    claims,
    typed,
    userInputs,
    runs,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("HarnessDeliveries", () => {
  it("does not record user input when it types an agent's message", async () => {
    const h = harness();
    await h.deliveries.send("t1", COMMAND, "hello", ["m1"]);
    h.advance(QUEUE_CONFIRM_MS);
    await h.deliveries.tick(() => ({ pane: true, atPrompt: true }));
    expect(h.typed).toEqual(["hello"]);
    expect(h.userInputs).toEqual([]);
  });

  it("records user input when it types the Review command (the user's own submit)", async () => {
    const h = harness();
    await h.deliveries.send("t1", COMMAND, "$plannotator-review", [], {
      userInput: true,
    });
    h.advance(QUEUE_CONFIRM_MS);
    await h.deliveries.tick(() => ({ pane: true, atPrompt: true }));
    expect(h.typed).toEqual(["$plannotator-review"]);
    expect(h.userInputs).toEqual(["t1"]);
  });

  it("keeps a queued message pending until the agent's next turn confirms it", async () => {
    const h = harness();
    expect(await h.deliveries.send("t1", COMMAND, "hello", ["m1"])).toBe(true);
    expect(h.deliveries.has("t1")).toBe(true);
    expect(h.claims).toEqual([]); // still pending in core
    // A second send for the same task waits its turn.
    expect(await h.deliveries.send("t1", COMMAND, "again", ["m2"])).toBe(false);
    await h.deliveries.confirm("t1");
    expect(h.claims).toEqual([["m1"]]);
    expect(h.deliveries.has("t1")).toBe(false);
    expect(h.typed).toEqual([]);
  });

  it("types it after a minute unconfirmed, only once the agent is at its prompt", async () => {
    const h = harness();
    await h.deliveries.send("t1", COMMAND, "hello", ["m1"]);
    const atPrompt = { pane: true, atPrompt: true };
    h.advance(QUEUE_CONFIRM_MS - 1);
    await h.deliveries.tick(() => atPrompt);
    expect(h.typed).toEqual([]);
    h.advance(1);
    await h.deliveries.tick(() => ({ pane: true, atPrompt: false }));
    expect(h.typed).toEqual([]); // busy: still waiting
    await h.deliveries.tick(() => atPrompt);
    expect(h.claims).toEqual([["m1"]]);
    expect(h.typed).toEqual(["hello"]);
    expect(h.events).toContain("fallback-typed");
  });

  it("never types a message something else delivered meanwhile; drops entries whose pane is gone", async () => {
    const h = harness({ claimable: 0 });
    await h.deliveries.send("t1", COMMAND, "hello", ["m1"]);
    h.advance(QUEUE_CONFIRM_MS);
    await h.deliveries.tick(() => ({ pane: true, atPrompt: true }));
    expect(h.typed).toEqual([]);
    expect(h.events).toContain("fallback-skipped");

    await h.deliveries.send("t2", COMMAND, "x", ["m2"]);
    await h.deliveries.tick(() => ({ pane: false, atPrompt: false }));
    expect(h.deliveries.has("t2")).toBe(false);
    expect(h.claims).toEqual([["m1"]]); // m2 stays pending for the wake path
  });

  it("records nothing when the harness rejects the command", async () => {
    const h = harness({ run: false });
    expect(await h.deliveries.send("t1", COMMAND, "hello", ["m1"])).toBe(false);
    expect(h.deliveries.has("t1")).toBe(false);
    expect(h.events).toEqual(["queue-failed"]);
  });
});

describe("queue text", () => {
  const message = (overrides: Partial<TaskMessage>): TaskMessage => ({
    id: "m",
    sender: { kind: "task", taskId: "p" },
    senderLabel: "Parent",
    targetTaskId: "t1",
    route: "parent-to-child",
    text: "do this",
    requestedMode: "followUp",
    attachments: [],
    status: "pending",
    createdAt: "2026-11-17T10:00:00.000Z",
    ...overrides,
  });

  it("delivers pending messages to the task oldest first, leaving the Review button's own to its transport", () => {
    const list = [
      message({ id: "b", createdAt: "2026-11-17T10:00:02.000Z" }),
      message({ id: "a", createdAt: "2026-11-17T10:00:01.000Z" }),
      message({ id: "review", route: "user", sender: { kind: "user" } }),
      message({ id: "done", status: "delivered" }),
      message({ id: "other", targetTaskId: "t2" }),
    ];
    expect(deliverableMessages("t1", list).map((m) => m.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("formats like the inbox hooks (header, body, trust line), joined", () => {
    const text = queueTextFor([
      message({ text: "one" }),
      message({ text: "two" }),
    ]);
    expect(text).toContain('[Message from your parent task "Parent" (p)]');
    expect(text.split("\n\n---\n\n")).toHaveLength(2);
    expect(text).toContain("not from the user");
  });

  it("a child's automatic report carries no report_status reminder, an ordinary message does", () => {
    const options = { receiverHasParent: true };
    expect(queueTextFor([message({ text: "hi" })], options)).toContain(
      REPORT_STATUS_REMINDER,
    );
    expect(
      queueTextFor(
        [message({ text: "done", route: "child-to-parent", kind: "report" })],
        options,
      ),
    ).not.toContain(REPORT_STATUS_REMINDER);
  });
});

describe("OSC 9 notes (X4)", () => {
  it("splits OSC 9 sequences out of the stream, also across chunks", () => {
    const splitter = new Osc9Splitter();
    expect(splitter.feed("a\x1b]9;O")).toEqual([{ kind: "text", text: "a" }]);
    expect(splitter.hasPending).toBe(true);
    expect(splitter.feed("K\x07b\x1b]7501;state=done\x07")).toEqual([
      { kind: "osc9", raw: "\x1b]9;OK\x07", body: "OK" },
      { kind: "text", text: "b\x1b]7501;state=done\x07" },
    ]);
    // A partial introducer is held, then released as text.
    expect(splitter.feed("x\x1b]")).toEqual([{ kind: "text", text: "x" }]);
    expect(splitter.feed("0;title\x07")).toEqual([
      { kind: "text", text: "\x1b]0;title\x07" },
    ]);
    expect(new Osc9Splitter().feed("\x1b]9;st\x1b\\")).toEqual([
      { kind: "osc9", raw: "\x1b]9;st\x1b\\", body: "st" },
    ]);
  });

  it("an OSC 9 body right before done becomes its message; progress bodies are ignored", () => {
    expect(osc9Message("4;1;50")).toBeUndefined();
    expect(osc9Message("  ")).toBeUndefined();
    expect(osc9Message("Done\nnow")).toBe("Done now");
    const joiner = new DoneMessageJoiner();
    joiner.noteOsc9("OK");
    expect(joiner.apply({ state: "done" })).toEqual({
      state: "done",
      message: "OK",
    });
    // Consumed: the next done has none of its own.
    expect(joiner.apply({ state: "done" })).toEqual({ state: "done" });
    // Any other report in between clears it; a done's own message wins.
    joiner.noteOsc9("stale");
    joiner.apply({ state: "working" });
    expect(joiner.apply({ state: "done" })).toEqual({ state: "done" });
    joiner.noteOsc9("note");
    expect(joiner.apply({ state: "done", message: "own" })).toEqual({
      state: "done",
      message: "own",
    });
    joiner.noteOsc9("4;3;0");
    expect(joiner.apply({ state: "done" })).toEqual({ state: "done" });
  });
});

describe("typing a Codex skill", () => {
  it("adds a space after a bare $skill (closes Codex's completion popup) and pastes multi-line text", async () => {
    expect(typedCommandText("$plannotator-review")).toBe(
      "$plannotator-review ",
    );
    expect(typedCommandText("$plannotator-review https://x/pull/1")).toBe(
      "$plannotator-review https://x/pull/1",
    );
    expect(typedCommandText("/plannotator-review")).toBe("/plannotator-review");
    const writes: string[] = [];
    await typeText(
      (data) => {
        writes.push(data);
        return true;
      },
      "a\nb",
      async () => {},
    );
    expect(writes).toEqual(["\x1b[200~a\nb\x1b[201~", "\r"]);
  });
});
