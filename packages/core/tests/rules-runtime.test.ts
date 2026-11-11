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
    expect(action).toMatchObject({ file: "rules.yaml", line: 6 });

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
    on: harbormaster.task.*
    do: [{ action: inbox, with: { title: "hi \${task.title}" } }]
  - id: would-move
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
