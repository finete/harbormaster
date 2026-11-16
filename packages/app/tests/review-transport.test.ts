// The Review button's transport (main/review-transport.ts,
// docs/plannotator.md "Transport"): typed into the primary pty when the
// agent is at its prompt, queued (then typed once it settles) when it is
// working or the state is unsure, inbox delivery with no pty of ours.
import { describe, expect, it, vi } from "vitest";
import type { CorroboratedPresence } from "../src/main/presence-corroboration";
import {
  agentAtPrompt,
  createCommandRejectedMatcher,
  decideReviewTransport,
  QueuedReviews,
  TYPE_ENTER_DELAY_MS,
  typeCommand,
} from "../src/main/review-transport";

const idle: CorroboratedPresence = {
  live: true,
  runningTurn: false,
  corroboration: "record",
  status: { state: "idle" },
};
const working: CorroboratedPresence = {
  ...idle,
  runningTurn: true,
  status: { state: "working" },
};

describe("decideReviewTransport", () => {
  it("pane + agent at its prompt → type", () => {
    expect(decideReviewTransport({ pane: true, presence: idle })).toBe("type");
    for (const state of ["done", "error"] as const) {
      expect(
        decideReviewTransport({
          pane: true,
          presence: { ...idle, status: { state } },
        }),
      ).toBe("type");
    }
  });
  it("pane + agent working → queue", () => {
    expect(decideReviewTransport({ pane: true, presence: working })).toBe(
      "queue",
    );
  });
  it("no pty of ours → message, whatever presence says", () => {
    expect(decideReviewTransport({ pane: false, presence: idle })).toBe(
      "message",
    );
    expect(decideReviewTransport({ pane: false, presence: undefined })).toBe(
      "message",
    );
  });
  it("unsure the agent owns the prompt → queue, never typed", () => {
    const unsure: (CorroboratedPresence | undefined)[] = [
      undefined,
      // A record that is not the pane's own process (stale, a sub-shell…).
      { live: true, runningTurn: false, corroboration: "pane-only" },
      // A permission prompt or question: typing would answer it.
      { ...idle, status: { state: "blocked" } },
      // Never reported a status.
      { live: true, runningTurn: false, corroboration: "record" },
      { ...idle, live: false },
    ];
    for (const presence of unsure) {
      expect(agentAtPrompt(presence)).toBe(false);
      expect(decideReviewTransport({ pane: true, presence })).toBe("queue");
    }
  });
});

describe("typeCommand", () => {
  it("types the text, then Enter as its own keystroke", async () => {
    const writes: string[] = [];
    const sleep = vi.fn(async () => {});
    expect(
      await typeCommand(
        (data) => {
          writes.push(data);
          return true;
        },
        "/plannotator-review",
        sleep,
      ),
    ).toBe(true);
    expect(writes).toEqual(["/plannotator-review", "\r"]);
    expect(sleep).toHaveBeenCalledWith(TYPE_ENTER_DELAY_MS);
  });
  it("stops when the pty is gone", async () => {
    const write = vi.fn(() => false);
    expect(await typeCommand(write, "/x", async () => {})).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe("QueuedReviews", () => {
  function setup(claimed = true) {
    const claim = vi.fn(async () => claimed);
    const type = vi.fn(async () => true);
    return { claim, type, queue: new QueuedReviews({ claim, type }) };
  }

  it("keeps waiting while the agent works, then claims and types once it is at its prompt", async () => {
    const { claim, type, queue } = setup();
    queue.add("t1", "m1", "/plannotator-review");
    await queue.retry(() => ({ pane: true, presence: working }));
    expect(claim).not.toHaveBeenCalled();
    expect(queue.has("t1")).toBe(true);
    await queue.retry(() => ({ pane: true, presence: idle }));
    expect(claim).toHaveBeenCalledWith("t1", "m1");
    expect(type).toHaveBeenCalledWith("t1", "/plannotator-review");
    expect(queue.has("t1")).toBe(false);
  });
  it("does not type a message the agent's own delivery already claimed", async () => {
    const { type, queue } = setup(false);
    queue.add("t1", "m1", "/plannotator-review");
    await queue.retry(() => ({ pane: true, presence: idle }));
    expect(type).not.toHaveBeenCalled();
    expect(queue.has("t1")).toBe(false);
  });
  it("hands a task whose pty is gone to inbox delivery for good", async () => {
    const { claim, queue } = setup();
    queue.add("t1", "m1", "/plannotator-review");
    await queue.retry(() => ({ pane: false, presence: undefined }));
    expect(claim).not.toHaveBeenCalled();
    expect(queue.has("t1")).toBe(false);
  });
});

describe("createCommandRejectedMatcher", () => {
  const command = "/plannotator-review https://github.com/o/r/pull/1";

  it("matches Claude Code's Unknown command line (observed output)", () => {
    const rejected = createCommandRejectedMatcher(command);
    expect(
      rejected(
        "\u001b[33m●\u001b[39m Unknown command: /plannotator-review\r\n",
      ),
    ).toBe(true);
  });

  it("matches a line split across reads and drawn with cursor moves instead of spaces", () => {
    const rejected = createCommandRejectedMatcher(command);
    expect(rejected("● Unknown\u001b[1Ccomm")).toBe(false);
    expect(rejected("and:\u001b[1C/plannotator-review\r\n")).toBe(true);
  });

  it("ignores the echoed command, other unknown commands and normal output", () => {
    const rejected = createCommandRejectedMatcher(command);
    expect(rejected(`> ${command}\r\n`)).toBe(false);
    expect(rejected("Unknown command: /other\r\n")).toBe(false);
    expect(rejected("Plannotator session ready: http://127.0.0.1:1/\r\n")).toBe(
      false,
    );
  });

  it("never matches for a non-slash command", () => {
    const rejected = createCommandRejectedMatcher("!plannotator review");
    expect(rejected("Unknown command: !plannotator\r\n")).toBe(false);
  });
});
