// Harness usage readers (docs/costs.md "Harness file facts"), against
// fixture transcripts shaped like the real files on disk: Pi (cost
// pass-through, fork prefix from the header's `parentSession`) and Claude
// Code (requestId / message.id dedupe, sidechain turns, mixed models,
// subagent transcripts, `forkedFrom` prefix, no cost). The custom CLI
// adapter has no reader.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "../src/contracts/harness.js";
import type { PresenceAccess } from "../src/contracts/services.js";
import type { ModelUsage } from "../src/contracts/usage.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-adapter.js";
import { CustomHarnessAdapter } from "../src/harness/custom-adapter.js";
import { PiHarnessAdapter } from "../src/harness/pi-adapter.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "usage");
const SID = "11111111-1111-4111-8111-111111111111";
const FORK_SID = "33333333-3333-4333-8333-333333333333";

const noPresence = new Proxy({} as PresenceAccess, {
  get: (_target, key) =>
    key === "read" ? async () => undefined : async () => {},
});

const pi = new PiHarnessAdapter({ presence: noPresence });
const claude = new ClaudeCodeHarnessAdapter({
  presence: noPresence,
  transcripts: { exists: () => true },
});

function byModel(models: ModelUsage[]): Record<string, ModelUsage> {
  return Object.fromEntries(models.map((usage) => [usage.model, usage]));
}

describe("Pi readSessionUsage", () => {
  it("sums per model and passes Pi's own cost through", async () => {
    const path = join(FIXTURES, "pi", "parent.jsonl");
    const usage = await pi.readSessionUsage(path);
    expect(usage).toEqual({
      sessionPath: path,
      byModel: [
        {
          model: "claude-opus-5-5",
          input: 15,
          output: 150,
          cacheRead: 1000,
          cacheWrite: 1000,
          turns: 2,
          cost: 0.75,
        },
      ],
      costSource: "pi",
    });
  });

  it("marks a forked session and reports its copied prefix", async () => {
    const path = join(FIXTURES, "pi", "forked.jsonl");
    const usage = await pi.readSessionUsage(path);
    const models = byModel(usage?.byModel ?? []);
    expect(models["claude-opus-5-5"]).toMatchObject({
      input: 17,
      output: 180,
      cacheRead: 3000,
      cacheWrite: 1000,
      turns: 3,
      cost: 0.85,
    });
    expect(models["claude-fable-5-1"]).toMatchObject({ turns: 1, cost: 0.05 });
    expect(usage?.forkedFrom).toEqual({
      sessionPath: "/sessions/pi/parent.jsonl",
      turns: 2,
      prefix: [
        {
          model: "claude-opus-5-5",
          input: 15,
          output: 150,
          cacheRead: 1000,
          cacheWrite: 1000,
          turns: 2,
          cost: 0.75,
        },
      ],
    });
  });

  it("drops a model's cost when any of its turns has none", async () => {
    const usage = await pi.readSessionUsage(
      join(FIXTURES, "pi", "partial-cost.jsonl"),
    );
    expect(usage?.byModel[0]).toMatchObject({ turns: 2, input: 2 });
    expect(usage?.byModel[0]?.cost).toBeUndefined();
  });

  it("resolves undefined for a missing file", async () => {
    await expect(
      pi.readSessionUsage(join(FIXTURES, "pi", "nope.jsonl")),
    ).resolves.toBeUndefined();
  });
});

describe("Claude Code readSessionUsage", () => {
  it("counts each request once, includes sidechain and subagent turns, splits models, no cost", async () => {
    const path = join(FIXTURES, "claude", `${SID}.jsonl`);
    const usage = await claude.readSessionUsage(path);
    expect(usage?.costSource).toBeUndefined();
    expect(usage?.forkedFrom).toBeUndefined();
    const models = byModel(usage?.byModel ?? []);
    expect(Object.keys(models).sort()).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5-5",
    ]);
    // req_A (twice on disk) + sidechain req_C + msg_D (no requestId, twice)
    // + the older-layout sibling agent file of this session (req_F).
    expect(models["claude-opus-5-5"]).toEqual({
      model: "claude-opus-5-5",
      input: 10,
      output: 211,
      cacheRead: 1104,
      cacheWrite: 504,
      turns: 4,
    });
    // req_B + the subagents/agent-*.jsonl transcript (req_E).
    expect(models["claude-haiku-5-5"]).toEqual({
      model: "claude-haiku-5-5",
      input: 57,
      output: 13,
      cacheRead: 0,
      cacheWrite: 10,
      turns: 2,
    });
  });

  it("reports a --fork-session copy's prefix", async () => {
    const path = join(FIXTURES, "claude", `${FORK_SID}.jsonl`);
    const usage = await claude.readSessionUsage(path);
    expect(usage?.byModel).toEqual([
      {
        model: "claude-opus-5-5",
        input: 9,
        output: 260,
        cacheRead: 1600,
        cacheWrite: 506,
        turns: 2,
      },
    ]);
    expect(usage?.forkedFrom).toEqual({
      sessionPath: join(FIXTURES, "claude", `${SID}.jsonl`),
      turns: 1,
      prefix: [
        {
          model: "claude-opus-5-5",
          input: 3,
          output: 200,
          cacheRead: 1000,
          cacheWrite: 500,
          turns: 1,
        },
      ],
    });
  });

  it("resolves undefined for a missing transcript", async () => {
    await expect(
      claude.readSessionUsage(join(FIXTURES, "claude", "missing.jsonl")),
    ).resolves.toBeUndefined();
  });

  it("lists the session's subagent transcripts for the change check", async () => {
    await expect(
      claude.extraUsageFiles(join(FIXTURES, "claude", `${SID}.jsonl`)),
    ).resolves.toEqual([
      join(
        FIXTURES,
        "claude",
        SID,
        "subagents",
        "agent-a1b2c3d4e5f6a7b8.jsonl",
      ),
    ]);
    await expect(
      claude.extraUsageFiles(join(FIXTURES, "claude", "missing.jsonl")),
    ).resolves.toEqual([]);
  });

  it("locates a session's transcript under the cwd's project slug", () => {
    const adapter = new ClaudeCodeHarnessAdapter({
      presence: noPresence,
      configDir: "/cfg",
    });
    expect(
      adapter.expectedSessionFile("/Users/me/Code/.wt/task-1", SID),
    ).toEqual({
      dir: "/cfg/projects/-Users-me-Code--wt-task-1",
      fileSuffix: `${SID}.jsonl`,
    });
  });
});

describe("custom CLI adapter", () => {
  it("has no usage reader (usage is unavailable/unsupported)", () => {
    const custom: HarnessAdapter = new CustomHarnessAdapter(
      { id: "any", label: "Any", command: "any" },
      { presence: noPresence },
    );
    expect(custom.readSessionUsage).toBeUndefined();
  });
});
