// The rules engine end to end through createCore: rules files on disk
// (incl. the JS escape hatch), an addon source (snapshot + native push),
// the inbox / createTask / message actions, the audit log (`listEvents`),
// the `rulesCheck` dry run, `listAddons`/`listRules`, and first-run
// defaults. Repository-less tasks only: no git, no GitHub.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEntry } from "../src/contracts/rules.js";
import { createCore } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

let clockNow = new Date("2026-03-01T10:00:00.000Z");

async function setup(files: Record<string, string>, config: object = {}) {
  const root = await mkdtemp(join(tmpdir(), "harbormaster-rules-"));
  roots.push(root);
  const stateDir = join(root, "state");
  await mkdir(join(root, "Code"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "config.json"),
    JSON.stringify({
      automation: true,
      codeRoot: join(root, "Code"),
      ...config,
    }),
  );
  for (const [file, text] of Object.entries(files)) {
    const path = join(stateDir, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  }
  let n = 0;
  clockNow = new Date("2026-03-01T10:00:00.000Z");
  const core = createCore({
    stateDir,
    clock: { now: () => clockNow },
    ids: { next: () => `id-${++n}` },
  });
  return { core, stateDir };
}

const RULES = `rules:
  - id: greet
    label: greet
    on: harbormaster.task.appeared
    if: "js:./checks.mjs#isScratch"
    do:
      - action: inbox
        with:
          title: "New: \${task.title}"
          buttons:
            - { label: Open, action: openTask }
            - { label: Later, action: snooze }
            - { label: Dismiss, action: dismiss }
      - action: message
        with: { text: hello }
  - id: spawn
    label: spawn
    on: pinger.ping
    do:
      - action: "js:./actions.mjs#spawn"
        with: { n: "\${event.data.n}" }
`;

const CHECKS = `export function isScratch({ task }) { return task.kind === "temp_task" && !task.title.startsWith("Spawned"); }\n`;
const ACTIONS = `export function spawn(input) {
  return { action: "createTask", with: { title: "Spawned " + input.with.n } };
}\n`;

const ADDON_MANIFEST = JSON.stringify({
  name: "pinger",
  version: "0.1.0",
  provides: { sources: ["pinger"], rules: "suggested.yaml" },
});
const ADDON_SOURCE = `export default {
  id: "pinger",
  subscribe(emit) {
    emit({ type: "pinger.ping", id: "p1", data: { n: 1 } });
    emit({ type: "pinger.ping", id: "p1", data: { n: 1 } });
    return () => {};
  },
};\n`;

describe("rules runtime through createCore", () => {
  it("runs rules from disk (JS escape hatch, addon push events) into the inbox, audit log and core commands", async () => {
    const { core } = await setup({
      "rules/rules.yaml": RULES,
      "rules/checks.mjs": CHECKS,
      "rules/actions.mjs": ACTIONS,
      "addons/pinger/addon.json": ADDON_MANIFEST,
      "addons/pinger/source.mjs": ADDON_SOURCE,
      "addons/pinger/suggested.yaml": "rules: []\n",
      "addons/broken/addon.json": "{ nope",
    });
    const task = await core.commands.createTask({
      title: "Scratch idea",
      initialPrompt: "",
      start: true,
    });

    const first = await core.commands.refresh();
    // The broken addon is skipped and reported once, never fatal.
    expect(first.warnings).toEqual([
      expect.stringContaining("Addon broken skipped: addon.json:"),
    ]);
    // A rule's message goes through the approval route like any non-task sender.
    expect(await core.commands.listPendingApprovals()).toEqual([
      expect.objectContaining({
        sender: { kind: "rule", ruleId: "greet" },
        senderLabel: "Rule greet",
        targetTaskId: task.id,
        text: "hello",
      }),
    ]);

    const inbox = await core.commands.listInbox();
    expect(inbox).toEqual([
      expect.objectContaining({
        kind: "rule",
        title: "New: Scratch idea",
        taskId: task.id,
        ruleId: "greet",
        buttons: [
          { id: "b0", label: "Open", action: "openTask" },
          { id: "b1", label: "Later", action: "snooze" },
          { id: "b2", label: "Dismiss", action: "dismiss" },
        ],
      }),
    ]);
    // The pushed event was deduplicated (same source + id) and its JS
    // action created exactly one task.
    const board = (await core.commands.listBoard()).flatMap((column) =>
      column.groups.flatMap((group) => group.tasks.map((t) => t.title)),
    );
    expect(board.filter((title) => title === "Spawned 1")).toHaveLength(1);

    const events = await core.commands.listEvents({ taskId: task.id });
    const kinds = events.map((entry) =>
      entry.kind === "event"
        ? `event ${entry.event.type}`
        : entry.kind === "action"
          ? `action ${entry.ruleId} ${entry.action} ${entry.outcome}`
          : "warning",
    );
    expect(kinds).toEqual([
      "event harbormaster.task.appeared",
      "action greet inbox applied",
      "action greet message applied",
    ]);
    const action = events.find(
      (entry): entry is Extract<AuditEntry, { kind: "action" }> =>
        entry.kind === "action",
    );
    // The line of the `do` entry that ran (the rule itself starts at line 2).
    expect(action).toMatchObject({ file: "rules.yaml", line: 7 });

    // A second tick: nothing changed, nothing new happens.
    expect((await core.commands.refresh()).warnings).toEqual([]);
    expect(await core.commands.listInbox()).toHaveLength(1);

    // Snooze hides it for an hour; dismissing resolves it.
    const item = inbox[0]!;
    await core.commands.resolveInboxItem(item.id, { buttonId: "b1" });
    expect(await core.commands.listInbox()).toEqual([]);
    clockNow = new Date("2026-03-01T11:30:00.000Z");
    expect(await core.commands.listInbox()).toHaveLength(1);
    const opened = await core.commands.resolveInboxItem(item.id, {
      buttonId: "b0",
    });
    expect(opened.taskId).toBe(task.id);
    expect(opened.item.resolvedAt).toBeDefined();
    expect(await core.commands.listInbox()).toEqual([]);
    expect(
      await core.commands.listInbox({ includeResolved: true }),
    ).toHaveLength(1);
  });

  it("files `priority: false` rule items under Other, records the source, snoozes to a time, and applies the priority filter", async () => {
    const { core } = await setup(
      {
        "rules/rules.yaml": `rules:
  - id: fyi
    label: fyi
    on: harbormaster.task.appeared
    do:
      - action: inbox
        with: { title: "FYI \${task.title}", priority: false }
      - action: inbox
        with: { title: "Look at \${task.title}" }
`,
      },
      {
        inbox: {
          priorityFilter: 'item.kind == "asked" ? false : item.priority',
        },
      },
    );
    await core.commands.createTask({
      title: "T",
      initialPrompt: "",
      start: true,
    });
    await core.commands.refresh();
    const items = await core.commands.listInbox();
    expect(
      items.map((item) => [item.title, item.priority, item.source]),
    ).toEqual([
      ["FYI T", false, "harbormaster"],
      ["Look at T", undefined, "harbormaster"],
    ]);

    // Snooze without a button: hidden until the given time, not resolved.
    const until = "2026-03-02T08:00:00.000Z";
    const snoozed = await core.commands.resolveInboxItem(items[1]!.id, {
      snoozeUntil: until,
    });
    expect(snoozed.item).toMatchObject({ snoozedUntil: until });
    expect(snoozed.item.resolvedAt).toBeUndefined();
    expect(await core.commands.listInbox()).toHaveLength(1);
    await expect(
      core.commands.resolveInboxItem(items[1]!.id, { snoozeUntil: "soon" }),
    ).rejects.toThrow("Not a time: soon");

    // The configured CEL filter decides; a non-boolean keeps the default.
    expect(
      await core.commands.evaluateInboxPriority([
        { id: "a", kind: "asked", priority: true },
        { id: "b", kind: "idle", priority: false },
        { id: "c", kind: "rule", source: "github", priority: true },
      ]),
    ).toEqual([false, false, true]);
    expect(await core.commands.listReadyToLand()).toEqual([]);
  });

  it("rulesCheck replays recorded events through the current rules without executing anything", async () => {
    const { core, stateDir } = await setup({
      "rules/rules.yaml": "rules: []\n",
    });
    const task = await core.commands.createTask({
      title: "Later",
      initialPrompt: "",
      start: true,
    });
    await core.commands.refresh();
    await writeFile(
      join(stateDir, "rules", "rules.yaml"),
      `rules:
  - id: would-inbox
    label: would-inbox
    on: harbormaster.task.*
    do: [{ action: inbox, with: { title: "hi \${task.title}" } }]
  - id: would-move
    label: would-move
    on: harbormaster.task.appeared
    do: [{ action: move, with: { to: await, kind: slack } }]
`,
    );
    const check = await core.commands.rulesCheck({ taskId: task.id });
    expect(check.events).toBe(1);
    expect(
      check.plans.map((plan) => [
        plan.ruleId,
        plan.action,
        plan.outcome,
        plan.with,
      ]),
    ).toEqual([
      ["would-inbox", "inbox", "would-run", { title: "hi Later" }],
      ["would-move", "move", "would-move", { to: "await", kind: "slack" }],
    ]);
    expect(await core.commands.listInbox()).toEqual([]);
    expect((await core.commands.getTask(task.id))?.state).toBe("dev");
    expect(
      (await core.commands.rulesCheck({ replayFrom: "2026-03-02" })).events,
    ).toBe(0);
  });

  it("writes the default rules on first run and lists rules and addons (built-ins read-only)", async () => {
    const { core, stateDir } = await setup({
      "addons/pinger/addon.json": ADDON_MANIFEST,
      "addons/pinger/source.mjs": ADDON_SOURCE,
      "addons/pinger/suggested.yaml": "rules: []\n",
    });
    await core.commands.refresh();
    const written = await readFile(
      join(stateDir, "rules", "rules.yaml"),
      "utf8",
    );
    expect(written).toContain("id: review-changes-requested");
    const { files } = await core.commands.listRules();
    expect(files).toEqual([
      expect.objectContaining({ file: "rules.yaml", problems: [] }),
    ]);
    expect(files[0]?.rules.length).toBeGreaterThan(5);

    const addons = await core.commands.listAddons();
    expect(
      addons.map((addon) => [
        addon.name,
        addon.builtin,
        addon.readOnly,
        addon.loaded,
      ]),
    ).toEqual([
      ["harbormaster-builtin", true, true, true],
      ["pinger", false, false, true],
    ]);
    expect(addons[0]?.sources.map((source) => source.id)).toEqual([
      "harbormaster",
      "github",
      "version-endpoint",
    ]);
    expect(addons[1]?.suggestedRules).toBe("rules: []\n");
  });

  it("records where a move started and the rule's label in the audit", async () => {
    const { core } = await setup({
      "rules/rules.yaml": `rules:
  - id: finish-scratch
    label: Scratch finished
    on: harbormaster.task.appeared
    do: [{ action: move, with: { to: done } }]
`,
    });
    const task = await core.commands.createTask({
      title: "Scratch",
      initialPrompt: "",
      start: true,
    });
    await core.commands.refresh();
    const action = (await core.commands.listEvents({ taskId: task.id })).find(
      (entry): entry is Extract<AuditEntry, { kind: "action" }> =>
        entry.kind === "action",
    );
    expect(action).toMatchObject({
      ruleId: "finish-scratch",
      ruleLabel: "Scratch finished",
      from: { state: "dev" },
      outcome: "applied",
    });
    expect(action?.from).not.toHaveProperty("awaitingKind");
  });

  it("does nothing automatic with the kill switch off", async () => {
    const { core } = await setup(
      { "rules/rules.yaml": RULES, "rules/checks.mjs": CHECKS },
      { automation: false },
    );
    await core.commands.createTask({
      title: "Quiet",
      initialPrompt: "",
      start: true,
    });
    await core.commands.refresh();
    expect(await core.commands.listInbox()).toEqual([]);
    expect(await core.commands.listEvents()).toEqual([]);
  });
});

describe("the Rules page data (listRules / listEvents / setRulesEnabled)", () => {
  const GLOBAL = `rules:
  - id: r1
    label: Needs changes
    on: github.pr.*
    if: task.state == "awaiting" && (a || b)
    do: [{ action: move, with: { to: dev } }]
  - id: r2
    label: Quiet
    on: github.pr.*
    do: [{ action: move, with: { to: dev } }]
`;
  const REPO = `rules:
  - id: r1
    label: Repo override
    on: github.pr.*
    if: "js:./checks.mjs#fn"
    do: [{ action: move, with: { to: dev } }]
`;
  const act = (
    at: string,
    file: string,
    outcome: string,
    extra: object = {},
  ): string =>
    JSON.stringify({
      kind: "action",
      at,
      ruleId: "r1",
      file,
      line: 2,
      eventId: "e1",
      eventType: "github.pr.stateChanged",
      action: "move",
      outcome,
      ...extra,
    });
  const REPO_FILE = "repos/github.com/acme/api.yaml";

  async function seeded(config: object = {}) {
    const lines = (entries: string[]) => `${entries.join("\n")}\n`;
    return setup(
      {
        "rules/rules.yaml": GLOBAL,
        [`rules/${REPO_FILE}`]: REPO,
        // Outside the 30-day window ending 2026-03-01T10:00Z.
        "events/2026-01-15.jsonl": lines([
          act("2026-01-15T10:00:00.000Z", "rules.yaml", "applied"),
        ]),
        "events/2026-02-20.jsonl": lines([
          JSON.stringify({
            kind: "event",
            at: "2026-02-20T09:00:00.000Z",
            taskId: "t1",
            event: {
              specversion: "1.0",
              id: "e1",
              source: "github",
              type: "github.pr.stateChanged",
              subject: "task/t1",
              time: "2026-02-20T09:00:00.000Z",
            },
          }),
          act("2026-02-20T10:00:00.000Z", "rules.yaml", "applied", {
            taskId: "t1",
          }),
          act("2026-02-20T11:00:00.000Z", REPO_FILE, "stayed", {
            taskId: "t2",
            detail: "dirty worktree",
          }),
        ]),
        "events/2026-02-28.jsonl": lines([
          act("2026-02-28T10:00:00.000Z", "rules.yaml", "failed", {
            taskId: "t3",
            detail: "boom",
          }),
          JSON.stringify({
            kind: "warning",
            at: "2026-02-28T10:00:01.000Z",
            message: "condition error",
            ruleId: "r1",
            file: "rules.yaml",
            line: 2,
          }),
        ]),
      },
      config,
    );
  }

  it("listRules carries the absolute path, the on/off state, conditions and 30-day activity per (file, rule)", async () => {
    const { core, stateDir } = await seeded();
    const listing = await core.commands.listRules();
    expect(listing.enabled).toBe(true);
    expect(listing.activityWindowDays).toBe(30);
    expect(
      listing.files.map((file) => [file.file, file.path, file.repositoryId]),
    ).toEqual([
      ["rules.yaml", join(stateDir, "rules", "rules.yaml"), undefined],
      [
        REPO_FILE,
        join(stateDir, "rules", "repos", "github.com", "acme", "api.yaml"),
        "github.com/acme/api",
      ],
    ]);
    const [global, repo] = listing.files;
    expect(global?.rules.map((rule) => [rule.id, rule.label])).toEqual([
      ["r1", "Needs changes"],
      ["r2", "Quiet"],
    ]);
    expect(global?.rules[0]?.condition).toEqual({
      kind: "cel",
      source: 'task.state == "awaiting" && (a || b)',
      outline: {
        kind: "all",
        items: [
          { kind: "leaf", text: 'task.state == "awaiting"' },
          {
            kind: "any",
            items: [
              { kind: "leaf", text: "a" },
              { kind: "leaf", text: "b" },
            ],
          },
        ],
      },
    });
    expect(global?.rules[0]?.activity).toEqual({
      lastAt: "2026-02-28T10:00:00.000Z",
      lastOutcome: "failed",
      lastDetail: "boom",
      lastTaskId: "t3",
      count: 2,
    });
    expect(global?.rules[1]).not.toHaveProperty("activity");
    expect(repo?.rules[0]?.condition).toEqual({
      kind: "js",
      ref: "js:./checks.mjs#fn",
    });
    expect(repo?.rules[0]?.activity).toEqual({
      lastAt: "2026-02-20T11:00:00.000Z",
      lastOutcome: "stayed",
      lastDetail: "dirty worktree",
      lastTaskId: "t2",
      count: 1,
    });
  });

  it("listEvents keeps one rule's actions and warnings, optionally of one file", async () => {
    const { core } = await seeded();
    const summary = (entries: AuditEntry[]) =>
      entries.map((entry) => [
        entry.kind,
        entry.kind === "event" ? undefined : entry.file,
        entry.at,
      ]);
    expect(summary(await core.commands.listEvents({ ruleId: "r1" }))).toEqual([
      ["action", "rules.yaml", "2026-01-15T10:00:00.000Z"],
      ["action", "rules.yaml", "2026-02-20T10:00:00.000Z"],
      ["action", REPO_FILE, "2026-02-20T11:00:00.000Z"],
      ["action", "rules.yaml", "2026-02-28T10:00:00.000Z"],
      ["warning", "rules.yaml", "2026-02-28T10:00:01.000Z"],
    ]);
    expect(
      summary(
        await core.commands.listEvents({
          ruleId: "r1",
          file: "rules.yaml",
          limit: 2,
        }),
      ),
    ).toEqual([
      ["action", "rules.yaml", "2026-02-28T10:00:00.000Z"],
      ["warning", "rules.yaml", "2026-02-28T10:00:01.000Z"],
    ]);
    expect(
      summary(
        await core.commands.listEvents({ ruleId: "r1", file: REPO_FILE }),
      ),
    ).toEqual([["action", REPO_FILE, "2026-02-20T11:00:00.000Z"]]);
    expect(await core.commands.listEvents({ ruleId: "r2" })).toEqual([]);
    // Without a rule filter, events are still listed.
    expect(await core.commands.listEvents({ taskId: "t1" })).toHaveLength(2);
  });

  it("setRulesEnabled writes config.automation, keeping every other key", async () => {
    const { core, stateDir } = await seeded({ customKey: "kept" });
    await core.commands.setRulesEnabled(false);
    expect((await core.commands.listRules()).enabled).toBe(false);
    const written = JSON.parse(
      await readFile(join(stateDir, "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(written).toMatchObject({ automation: false, customKey: "kept" });
    await core.commands.setRulesEnabled(true);
    expect((await core.commands.listRules()).enabled).toBe(true);
    await expect(
      core.commands.setRulesEnabled("yes" as unknown as boolean),
    ).rejects.toThrow("enabled must be true or false");
  });

  it("a rule without a label is a load problem: the file contributes no rules", async () => {
    const { core } = await setup({
      "rules/rules.yaml": `rules:
  - id: labelled
    label: Fine
    on: a
    do: [{ action: move, with: { to: dev } }]
  - id: unlabelled
    on: a
    do: [{ action: move, with: { to: dev } }]
  - id: empty
    label: ""
    on: a
    do: [{ action: move, with: { to: dev } }]
`,
    });
    const [file] = (await core.commands.listRules()).files;
    expect(file?.rules).toEqual([]);
    expect(file?.problems).toEqual([
      'rules.yaml:6: rule "unlabelled": label is required',
      'rules.yaml:9: rule "empty": label is required',
    ]);
  });
});
