// Pure helpers behind main's task-messaging push (main/messaging-push.ts):
// the unchanged-payload dedupe, the messages.json-only watch filter, and
// the hourly prune gate.
import { describe, expect, it } from "vitest";
import {
  createDedupedPusher,
  createIntervalGate,
  isMessagesLogChange,
  PRUNE_INTERVAL_MS,
} from "../src/main/messaging-push";

describe("isMessagesLogChange", () => {
  it("accepts only messages.json (not the lock, doorbell or attachments)", () => {
    expect(isMessagesLogChange("messages.json")).toBe(true);
    for (const name of [
      "messages.lock",
      "doorbell",
      "attachments",
      "messages.json.tmp",
      null,
    ]) {
      expect(isMessagesLogChange(name)).toBe(false);
    }
  });
});

describe("createDedupedPusher", () => {
  function setup(initial: unknown) {
    let current = initial;
    const sent: unknown[] = [];
    const pusher = createDedupedPusher({
      load: async () => structuredClone(current),
      send: (payload) => sent.push(payload),
    });
    return {
      pusher,
      sent,
      set: (next: unknown) => {
        current = next;
      },
    };
  }

  it("sends the first payload, then suppresses identical ones", async () => {
    const { pusher, sent } = setup({ approvals: [], states: [] });
    await pusher.push();
    await pusher.push();
    await pusher.push();
    expect(sent).toHaveLength(1);
  });

  it("sends again once the payload changes", async () => {
    const { pusher, sent, set } = setup({ n: 1 });
    await pusher.push();
    set({ n: 2 });
    await pusher.push();
    expect(sent).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("force sends an unchanged payload", async () => {
    const { pusher, sent } = setup({ n: 1 });
    await pusher.push();
    await pusher.push({ force: true });
    expect(sent).toHaveLength(2);
  });

  it("invalidate makes the next identical push go out (a window fetched on its own)", async () => {
    const { pusher, sent } = setup({ n: 1 });
    await pusher.push();
    pusher.invalidate();
    await pusher.push();
    expect(sent).toHaveLength(2);
  });

  it("a failing load reports through onError, never rejects, and recovers", async () => {
    const errors: unknown[] = [];
    const sent: unknown[] = [];
    let fail = true;
    const pusher = createDedupedPusher({
      load: async () => {
        if (fail) throw new Error("half-written");
        return { ok: true };
      },
      send: (payload) => sent.push(payload),
      onError: (error) => errors.push(error),
    });
    await expect(pusher.push()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    fail = false;
    await pusher.push();
    expect(sent).toEqual([{ ok: true }]);
  });

  it("overlapping pushes collapse into one load + one trailing run", async () => {
    let loads = 0;
    const sent: unknown[] = [];
    const pusher = createDedupedPusher({
      load: async () => {
        loads += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { same: true };
      },
      send: (payload) => sent.push(payload),
    });
    await Promise.all([pusher.push(), pusher.push(), pusher.push()]);
    expect(loads).toBe(2);
    expect(sent).toHaveLength(1);
  });
});

describe("createIntervalGate", () => {
  it("allows the first run, blocks within the interval, allows after it", () => {
    let now = 1_000;
    const gate = createIntervalGate(PRUNE_INTERVAL_MS, () => now);
    expect(gate.tryAcquire()).toBe(true);
    now += PRUNE_INTERVAL_MS - 1;
    expect(gate.tryAcquire()).toBe(false);
    now += 1;
    expect(gate.tryAcquire()).toBe(true);
    now += 10;
    expect(gate.tryAcquire()).toBe(false);
  });
});
