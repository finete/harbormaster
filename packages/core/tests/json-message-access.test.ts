// Tests for the file-backed message store (see /docs/task-messaging.md):
// atomic claims, the per-task doorbell, and attachment copies. Each test uses
// a throwaway state directory.

import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonMessageAccess } from "../src/access/json-message-access.js";
import type { TaskMessage } from "../src/contracts/messaging.js";
import { resolveStatePaths } from "../src/utilities/state-paths.js";

let root: string;
let paths: ReturnType<typeof resolveStatePaths>;
let access: JsonMessageAccess;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harbormaster-messages-"));
  paths = resolveStatePaths(join(root, "state"));
  access = new JsonMessageAccess(paths);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let seq = 0;
function msg(target: string, extra: Partial<TaskMessage> = {}): TaskMessage {
  seq += 1;
  return {
    id: `msg-${seq}`,
    sender: { kind: "task", taskId: "sender" },
    senderLabel: "Sender",
    targetTaskId: target,
    route: "parent-to-child",
    text: `hello ${seq}`,
    requestedMode: "steer",
    attachments: [],
    status: "pending",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    ...extra,
  };
}

const claimInput = (idle: boolean) => ({
  idle,
  deliveredAt: "2026-02-01T00:00:00.000Z",
  resolveMode: (mode: "steer" | "followUp") => mode,
});

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("message log", () => {
  it("starts empty and round-trips records and user inputs", async () => {
    expect(await access.readStore()).toEqual({ messages: [], userInputs: {} });
    const m = msg("t1");
    await access.recordMessage(m);
    await access.recordUserInput("t1", "2026-01-02T00:00:00.000Z");
    const store = await access.readStore();
    expect(store.messages).toEqual([m]);
    expect(store.userInputs).toEqual({ t1: "2026-01-02T00:00:00.000Z" });
    expect(await access.getMessage(m.id)).toEqual(m);
    expect(await access.getMessage("nope")).toBeUndefined();
  });

  it("rejects duplicate ids and honors a failing precondition without writing", async () => {
    const m = msg("t1");
    await access.recordMessage(m);
    await expect(access.recordMessage(m)).rejects.toThrow(/already exists/);
    await expect(
      access.recordMessage(msg("t1"), {
        precondition: (store) => {
          expect(store.messages).toHaveLength(1);
          throw new Error("cap");
        },
      }),
    ).rejects.toThrow("cap");
    expect(await access.listMessages()).toHaveLength(1);
  });

  it("filters by sender or target task", async () => {
    await access.recordMessage(msg("a"));
    await access.recordMessage(
      msg("b", { sender: { kind: "session", cwd: "/x" } }),
    );
    await access.recordMessage(
      msg("c", { sender: { kind: "task", taskId: "a" } }),
    );
    expect(
      (await access.listMessages({ taskId: "a" })).map((m) => m.targetTaskId),
    ).toEqual(["a", "c"]);
    expect(await access.listMessages({ taskId: "zzz" })).toEqual([]);
  });

  it("approve applies edits and keeps the original text; reject and fail are status-guarded", async () => {
    const m = msg("t", { status: "awaiting_approval", route: "approval" });
    await access.recordMessage(m);
    const approved = await access.approveMessage(m.id, {
      approvedAt: "2026-01-05T00:00:00.000Z",
      text: "edited",
      mode: "followUp",
    });
    expect(approved).toMatchObject({
      status: "pending",
      text: "edited",
      originalText: m.text,
      requestedMode: "followUp",
      approvedAt: "2026-01-05T00:00:00.000Z",
    });
    await expect(
      access.approveMessage(m.id, { approvedAt: "x" }),
    ).rejects.toThrow(/not awaiting approval/);
    await expect(access.rejectMessage(m.id, "x")).rejects.toThrow(
      /not awaiting approval/,
    );
    await expect(
      access.approveMessage("missing", { approvedAt: "x" }),
    ).rejects.toThrow(/not found/);

    const r = msg("t", { status: "awaiting_approval" });
    await access.recordMessage(r);
    expect(
      await access.rejectMessage(r.id, "2026-01-06T00:00:00.000Z"),
    ).toMatchObject({
      status: "rejected",
      rejectedAt: "2026-01-06T00:00:00.000Z",
    });

    const f = await access.failMessage(
      approved.id,
      "2026-01-07T00:00:00.000Z",
      "gone",
    );
    expect(f).toMatchObject({ status: "failed", failureReason: "gone" });
    // A delivered message is left alone.
    const d = msg("t");
    await access.recordMessage(d);
    await access.claimDeliverable("t", claimInput(true));
    expect((await access.failMessage(d.id, "x", "late"))?.status).toBe(
      "delivered",
    );
    expect(await access.failMessage("missing", "x", "r")).toBeUndefined();
  });

  it("failPendingForTask fails only pending messages of that task", async () => {
    const a = msg("t");
    const b = msg("t", { status: "awaiting_approval" });
    const c = msg("other");
    for (const m of [a, b, c]) await access.recordMessage(m);
    const failed = await access.failPendingForTask("t", "now", "Done");
    expect(failed.map((m) => m.id)).toEqual([a.id]);
    const byId = Object.fromEntries(
      (await access.listMessages()).map((m) => [m.id, m.status]),
    );
    expect(byId).toEqual({
      [a.id]: "failed",
      [b.id]: "awaiting_approval",
      [c.id]: "pending",
    });
  });

  it("lists pending targets", async () => {
    await access.recordMessage(msg("a"));
    await access.recordMessage(msg("a"));
    await access.recordMessage(msg("b", { status: "awaiting_approval" }));
    await access.recordMessage(msg("c"));
    expect((await access.listPendingTargets()).sort()).toEqual(["a", "c"]);
  });

  it("rejects a corrupt store", async () => {
    await mkdir(paths.messagesDir, { recursive: true });
    await writeFile(paths.messagesFile, JSON.stringify({ version: 2 }));
    await expect(access.readStore()).rejects.toThrow(/corrupt message state/);
  });
});

describe("claimDeliverable", () => {
  it("claims oldest first, stamping deliveredAt and the resolved mode", async () => {
    const second = msg("t", { createdAt: "2026-01-01T00:00:09.000Z" });
    const first = msg("t", { createdAt: "2026-01-01T00:00:01.000Z" });
    await access.recordMessage(second);
    await access.recordMessage(first);
    const claimed = await access.claimDeliverable("t", {
      idle: true,
      deliveredAt: "2026-02-01T00:00:00.000Z",
      resolveMode: () => "followUp",
    });
    expect(claimed.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(claimed[0]).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-02-01T00:00:00.000Z",
      deliveredMode: "followUp",
      requestedMode: "steer",
    });
    expect(await access.claimDeliverable("t", claimInput(true))).toEqual([]);
  });

  it("claims followUp only when idle; steer any time (by the resolved mode)", async () => {
    const steer = msg("t", { requestedMode: "steer" });
    const follow = msg("t", { requestedMode: "followUp" });
    await access.recordMessage(steer);
    await access.recordMessage(follow);
    expect(
      (await access.claimDeliverable("t", claimInput(false))).map((m) => m.id),
    ).toEqual([steer.id]);
    expect(
      (await access.claimDeliverable("t", claimInput(true))).map((m) => m.id),
    ).toEqual([follow.id]);

    const downgraded = msg("t", { requestedMode: "steer" });
    await access.recordMessage(downgraded);
    const noSteer = {
      deliveredAt: "x",
      resolveMode: () => "followUp" as const,
    };
    expect(
      await access.claimDeliverable("t", { ...noSteer, idle: false }),
    ).toEqual([]);
    expect(
      await access.claimDeliverable("t", { ...noSteer, idle: true }),
    ).toHaveLength(1);
  });

  it("never hands the same message to two concurrent claimers (even across instances)", async () => {
    const other = new JsonMessageAccess(paths);
    const ids = Array.from({ length: 6 }, () => msg("t"));
    for (const m of ids) await access.recordMessage(m);
    const claimers = [access, other, access, other, access, other];
    const results = await Promise.all(
      claimers.map((a) => a.claimDeliverable("t", claimInput(true))),
    );
    const got = results
      .flat()
      .map((m) => m.id)
      .sort();
    expect(got).toEqual(ids.map((m) => m.id).sort());
    expect(new Set(got).size).toBe(got.length);
  });

  it("does not touch other tasks' messages", async () => {
    await access.recordMessage(msg("a"));
    const b = msg("b");
    await access.recordMessage(b);
    expect(await access.claimDeliverable("a", claimInput(true))).toHaveLength(
      1,
    );
    expect((await access.getMessage(b.id))?.status).toBe("pending");
  });
});

describe("doorbell", () => {
  it("rings for the right task only, on a new pending message and on approval", async () => {
    let rungA = 0;
    let rungB = 0;
    const offA = access.watchDoorbell("task-a", () => {
      rungA += 1;
    });
    const offB = access.watchDoorbell("task-b", () => {
      rungB += 1;
    });
    try {
      await access.recordMessage(msg("task-a"));
      await waitFor(() => rungA > 0);
      expect(rungB).toBe(0);

      // Awaiting approval does not ring; approving does.
      const before = rungB;
      const m = msg("task-b", { status: "awaiting_approval" });
      await access.recordMessage(m);
      await new Promise((resolve) => setTimeout(resolve, 150)); // nothing should happen
      expect(rungB).toBe(before);
      await access.approveMessage(m.id, { approvedAt: "x" });
      await waitFor(() => rungB > before);
    } finally {
      offA();
      offB();
    }
  });

  it("stops ringing after unsubscribe and sanitizes task ids", async () => {
    let rung = 0;
    const off = access.watchDoorbell("../weird id", () => {
      rung += 1;
    });
    await access.recordMessage(msg("../weird id"));
    await waitFor(() => rung > 0);
    expect((await readdir(paths.doorbellDir)).includes(".._weird_id")).toBe(
      true,
    );
    off();
    const seen = rung;
    await access.recordMessage(msg("../weird id"));
    await new Promise((resolve) => setTimeout(resolve, 150)); // nothing should happen
    expect(rung).toBe(seen);
  });

  it("returns a no-op unsubscribe when watching is impossible", async () => {
    // The doorbell "directory" is a file: mkdir/watch fail, the call must not throw.
    await mkdir(paths.messagesDir, { recursive: true });
    await writeFile(paths.doorbellDir, "not a directory");
    const off = access.watchDoorbell("t", () => {});
    expect(() => off()).not.toThrow();
  });
});

describe("attachments", () => {
  async function file(
    name: string,
    content: string | Buffer = "data",
  ): Promise<string> {
    const path = join(root, name);
    await writeFile(path, content);
    return path;
  }

  it("copies, infers mime types, reads back and removes", async () => {
    const png = await file("shot.png", Buffer.from([1, 2, 3]));
    const note = await file("notes.MD", "# hi");
    const bin = await file("blob.xyz");
    const copies = await access.copyAttachments("m1", [png, note, bin]);
    expect(copies.map((c) => c.mimeType)).toEqual([
      "image/png",
      "text/markdown",
      undefined,
    ]);
    expect(copies.map((c) => c.bytes)).toEqual([3, 4, 4]);
    expect(copies[0]?.originalPath).toBe(png);
    expect(copies[0]?.path).toBe(
      join(paths.attachmentsDir, "m1", "0-shot.png"),
    );
    expect(copies[1]?.path).toBe(
      join(paths.attachmentsDir, "m1", "1-notes.MD"),
    );
    expect(await access.readAttachment(copies[0] as never)).toBe(
      Buffer.from([1, 2, 3]).toString("base64"),
    );

    await access.removeAttachments("m1");
    await expect(access.readAttachment(copies[0] as never)).rejects.toThrow(
      /pruned or is missing/,
    );
    await access.removeAttachments("m1"); // idempotent
    await expect(stat(join(paths.attachmentsDir, "m1"))).rejects.toThrow();
  });

  it("infers every supported extension", async () => {
    const names = [
      "a.png",
      "a.jpg",
      "a.jpeg",
      "a.gif",
      "a.webp",
      "a.pdf",
      "a.txt",
      "a.md",
    ];
    const copies = await access.copyAttachments(
      "m2",
      await Promise.all(names.map((n) => file(n))),
    );
    expect(copies.map((c) => c.mimeType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "application/pdf",
      "text/plain",
      "text/markdown",
    ]);
  });

  it("validates: absolute, existing, regular file, size, count", async () => {
    await expect(access.copyAttachments("m", ["relative.png"])).rejects.toThrow(
      /must be absolute/,
    );
    await expect(
      access.copyAttachments("m", [join(root, "missing.png")]),
    ).rejects.toThrow(/not found/);
    await expect(access.copyAttachments("m", [root])).rejects.toThrow(
      /not a regular file/,
    );
    const big = await file("big.bin", Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(access.copyAttachments("m", [big])).rejects.toThrow(
      /larger than 10 MB/,
    );
    const ok = await file("ok.bin", Buffer.alloc(10 * 1024 * 1024));
    expect(await access.copyAttachments("m3", [ok])).toHaveLength(1);
    const many = await Promise.all(
      Array.from({ length: 9 }, (_, i) => file(`f${i}.txt`)),
    );
    await expect(access.copyAttachments("m", many)).rejects.toThrow(
      /Too many attachments/,
    );
    expect(await access.copyAttachments("m", many.slice(0, 8))).toHaveLength(8);
    // A failed validation copies nothing.
    await expect(
      access.copyAttachments("m4", [ok, "relative"]),
    ).rejects.toThrow();
    await expect(stat(join(paths.attachmentsDir, "m4"))).rejects.toThrow();
    expect(await access.copyAttachments("none", [])).toEqual([]);
  });

  it("refuses to read outside the attachment store and neutralizes odd ids/names", async () => {
    const outside = await file("secret.txt");
    await expect(
      access.readAttachment({ path: outside, originalPath: outside, bytes: 1 }),
    ).rejects.toThrow(/outside/);
    const odd = await file("we ird?.txt");
    const [copy] = await access.copyAttachments("..", [odd]);
    expect(copy?.path.startsWith(`${paths.attachmentsDir}/`)).toBe(true);
    expect(copy?.path).toContain("/__/0-we_ird_.txt");
  });

  it("stamps prunedAt on every attachment once", async () => {
    const m = msg("t", {
      attachments: [
        { path: "/a", originalPath: "/a", bytes: 1 },
        { path: "/b", originalPath: "/b", bytes: 1, prunedAt: "earlier" },
      ],
    });
    await access.recordMessage(m);
    await access.markAttachmentsPruned(m.id, "now");
    const stored = await access.getMessage(m.id);
    expect(stored?.attachments.map((a) => a.prunedAt)).toEqual([
      "now",
      "earlier",
    ]);
    await access.markAttachmentsPruned("missing", "now"); // no-op
  });
});
