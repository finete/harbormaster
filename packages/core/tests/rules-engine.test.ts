// biome-ignore-all lint/suspicious/noTemplateCurlyInString: rule templates are literal `${…}` strings.
// Unit tests for the pure rules-engine parts (engines/rules/*): rules-file
// parsing and validation, glob matching, CEL conditions and templates,
// snapshot diffing, arbitration, the JS escape hatch, and addon validation.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Task } from "../src/contracts/model.js";
import type {
  CloudEvent,
  RuleFile,
  RuleVariables,
} from "../src/contracts/rules.js";
import { validateAddons } from "../src/engines/rules/addons.js";
import { evaluateCondition, renderTemplate } from "../src/engines/rules/cel.js";
import {
  DEFAULT_RULES_YAML,
  defaultRulesYaml,
} from "../src/engines/rules/default-rules.js";
import {
  type EvaluationContext,
  matchRules,
  planActions,
} from "../src/engines/rules/evaluation.js";
import {
  activeRules,
  matchesEventType,
  parseRuleFile,
} from "../src/engines/rules/rule-files.js";
import { RULES_SCHEMA } from "../src/engines/rules/rules-schema.js";
import { diffSnapshots } from "../src/engines/rules/snapshot-diff.js";
import { toRuleTaskView } from "../src/engines/rules/views.js";

const parse = (text: string, file = "rules.yaml", repositoryId?: string) =>
  parseRuleFile({
    file,
    path: `/state/rules/${file}`,
    text,
    ...(repositoryId ? { repositoryId } : {}),
  });

describe("rules files", () => {
  it("parses rules with file and line numbers for the rule and each action", () => {
    const file = parse(`# comment
rules:
  - id: one
    label: Needs changes
    on: github.pr.*
    if: task.state == "dev"
    do:
      - action: move
        with: { to: dev }
      - action: inbox
        with: { title: hi }
  - id: two
    label: two
    on: [a.b, c.*]
    do: [{ action: "js:./x.mjs#fn" }]
`);
    expect(file.problems).toEqual([]);
    expect(file.rules).toEqual([
      {
        id: "one",
        label: "Needs changes",
        on: ["github.pr.*"],
        if: 'task.state == "dev"',
        do: [
          { action: "move", with: { to: "dev" }, line: 8 },
          { action: "inbox", with: { title: "hi" }, line: 10 },
        ],
        file: "rules.yaml",
        line: 3,
        condition: {
          kind: "cel",
          source: 'task.state == "dev"',
          outline: { kind: "leaf", text: 'task.state == "dev"' },
        },
      },
      {
        id: "two",
        label: "two",
        on: ["a.b", "c.*"],
        do: [{ action: "js:./x.mjs#fn", line: 15 }],
        file: "rules.yaml",
        line: 12,
        condition: { kind: "always" },
      },
    ]);
    expect(file.path).toBe("/state/rules/rules.yaml");
  });

  it("rejects (whole file) bad YAML, schema violations, duplicate ids and invalid CEL", () => {
    expect(parse("rules: [\n").problems[0]).toMatch(/^rules\.yaml: /);
    const schema = parse(
      "rules:\n  - id: x\n    label: x\n    on: a\n    do:\n      - action: move\n        with: { to: sideways }\n",
    );
    expect(schema.rules).toEqual([]);
    expect(schema.problems.join("\n")).toContain("/rules/0/do/0/with/to");
    expect(
      parse(
        "rules:\n  - id: x\n    label: x\n    on: a\n    do: [{ action: teleport }]\n",
      ).problems.length,
    ).toBeGreaterThan(0);
    expect(
      parse(
        "rules:\n  - { id: x, label: x, on: a, do: [{ action: move, with: { to: dev } }] }\n  - { id: x, label: x, on: b, do: [{ action: move, with: { to: dev } }] }\n",
      ).problems,
    ).toEqual([expect.stringContaining('duplicate rule id "x"')]);
    const cel = parse(
      "rules:\n  - id: x\n    label: x\n    on: a\n    if: task.state ==\n    do: [{ action: move, with: { to: dev } }]\n",
    );
    expect(cel.rules).toEqual([]);
    expect(cel.problems).toEqual([
      expect.stringContaining('rule "x" has an invalid condition'),
    ]);
  });

  it("a repository file replaces the global list for that repository, even when empty", () => {
    const global = parse(
      "rules:\n  - { id: g, label: g, on: a, do: [{ action: move, with: { to: dev } }] }\n",
    );
    const repo = parse(
      "rules: []\n",
      "repos/github.com/acme/x.yaml",
      "github.com/acme/x",
    );
    expect(activeRules([global, repo], "github.com/acme/x")).toEqual([]);
    expect(activeRules([global, repo], "github.com/acme/y")).toEqual(
      global.rules,
    );
    expect(activeRules([global, repo], null)).toEqual(global.rules);
  });

  it("matches event types exactly or by glob", () => {
    expect(
      matchesEventType("github.pr.mergedChanged", "github.pr.mergedChanged"),
    ).toBe(true);
    expect(matchesEventType("github.pr.*", "github.pr.mergedChanged")).toBe(
      true,
    );
    expect(matchesEventType("github.*", "github.pr.mergedChanged")).toBe(false);
    expect(matchesEventType("github.**", "github.pr.mergedChanged")).toBe(true);
    expect(matchesEventType("*.pr.appeared", "github.pr.appeared")).toBe(true);
    expect(
      matchesEventType("github.pr.*Changed", "github.pr.closedChanged"),
    ).toBe(true);
    expect(matchesEventType("github.pr.*", "githubXpr.y")).toBe(false);
  });

  it("ships the schema as packages/core/schemas/rules.schema.json, identical to the one core validates with", async () => {
    const shipped = JSON.parse(
      await readFile(
        join(__dirname, "..", "schemas", "rules.schema.json"),
        "utf8",
      ),
    );
    expect(shipped).toEqual(JSON.parse(JSON.stringify(RULES_SCHEMA)));
  });

  it("the default rules are valid; legacy mover lists keep only their rules", () => {
    const defaults = parse(DEFAULT_RULES_YAML);
    expect(defaults.problems).toEqual([]);
    expect(defaults.rules.map((rule) => rule.id)).toEqual([
      "pr-merged-enter-deploy",
      "review-changes-requested",
      "review-requested-enter-review",
      "deploy-adopt-first-stage",
      "deploy-advance-stage",
      "deploy-land",
      "reviewer-author-activity",
      "reviewer-pr-closed",
      "review-requested-inbox",
    ]);
    expect(parse(defaultRulesYaml([])).rules).toEqual([]);
    expect(parse(defaultRulesYaml([])).problems).toEqual([]);
    expect(
      parse(defaultRulesYaml(["deployment-pipeline"])).rules.map((r) => r.id),
    ).toEqual([
      "pr-merged-enter-deploy",
      "deploy-adopt-first-stage",
      "deploy-advance-stage",
      "deploy-land",
    ]);
  });
});

const event = (overrides: Partial<CloudEvent> = {}): CloudEvent => ({
  specversion: "1.0",
  id: "e1",
  source: "github",
  type: "github.pr.mergedChanged",
  subject: "task/t1",
  time: "2026-01-01T00:00:00Z",
  data: { from: false, to: true },
  ...overrides,
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    kind: "task",
    state: "dev",
    title: "Widget",
    initialPrompt: "",
    repositoryId: "github.com/acme/widgets",
    branch: "widget",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    stateChangedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const variables = (overrides: Partial<RuleVariables> = {}): RuleVariables => ({
  event: event(),
  task: toRuleTaskView(task()),
  facts: { github: { state: "merged", number: 7 } },
  repo: null,
  ...overrides,
});

describe("CEL conditions and templates", () => {
  it("evaluates conditions over event, task, facts, repo; a non-boolean throws", () => {
    expect(
      evaluateCondition(
        'task.state == "dev" && facts.github.state == "merged" && event.data.to == true',
        variables(),
      ),
    ).toBe(true);
    // Absent optional task fields are null, never a missing key.
    expect(
      evaluateCondition(
        "task.awaiting == null && task.pr == null",
        variables(),
      ),
    ).toBe(true);
    expect(() => evaluateCondition("facts.github.number", variables())).toThrow(
      "must be a boolean",
    );
    expect(() => evaluateCondition("facts.nope.x == 1", variables())).toThrow();
  });

  it("renders whole-string templates typed and embedded ones as text, recursively", () => {
    expect(
      renderTemplate(
        {
          number: "${facts.github.number}",
          title: "PR #${facts.github.number} is ${facts.github.state}",
          list: ["${task.id}", "plain"],
        },
        variables(),
      ),
    ).toEqual({ number: 7, title: "PR #7 is merged", list: ["t1", "plain"] });
  });
});

describe("snapshot diff", () => {
  it("emits appeared, <field>Changed {from,to}, disappeared; stale subjects keep their facts silently", () => {
    let n = 0;
    const id = () => `id${++n}`;
    const first = diffSnapshots(
      "github",
      {},
      [
        { subject: "task/a", entity: "pr", facts: { state: "open", n: 1 } },
        { subject: "task/b", entity: "pr", facts: { state: "open" } },
      ],
      "T",
      id,
    );
    expect(first.events.map((e) => [e.type, e.subject])).toEqual([
      ["github.pr.appeared", "task/a"],
      ["github.pr.appeared", "task/b"],
    ]);
    expect(first.events[0]).toMatchObject({
      specversion: "1.0",
      source: "github",
      time: "T",
      data: { state: "open", n: 1 },
    });
    const second = diffSnapshots(
      "github",
      first.subjects,
      [
        {
          subject: "task/a",
          entity: "pr",
          facts: { state: "merged", n: 1, x: [1] },
        },
        { subject: "task/b", entity: "pr", facts: {}, stale: true },
      ],
      "T2",
      id,
    );
    expect(second.events.map((e) => [e.type, e.data])).toEqual([
      ["github.pr.stateChanged", { from: "open", to: "merged" }],
      ["github.pr.xChanged", { from: null, to: [1] }],
    ]);
    expect(second.subjects["task/b"]).toEqual(first.subjects["task/b"]);
    const third = diffSnapshots("github", second.subjects, [], "T3", id);
    expect(third.events.map((e) => e.type)).toEqual([
      "github.pr.disappeared",
      "github.pr.disappeared",
    ]);
    expect(third.subjects).toEqual({});
  });
});

function context(
  files: RuleFile[],
  tasks: Task[],
  js: Record<string, (argument: unknown) => unknown> = {},
): EvaluationContext {
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  return {
    files,
    task: (id) => byId.get(id),
    variables: (e, t) =>
      variables({ event: e, task: t ? toRuleTaskView(t) : null }),
    stages: () => [
      { id: "pre", label: "Preprod", hook: "version-endpoint", options: {} },
    ],
    callJs: async (reference, argument) => {
      const fn = js[reference];
      if (!fn) throw new Error(`no ${reference}`);
      return fn(argument);
    },
  };
}

describe("matching and arbitration", () => {
  const files = [
    parse(`rules:
  - id: illegal-first
    label: illegal-first
    on: github.pr.*
    do: [{ action: move, with: { to: await, kind: deploy, input: { stage: pre } } }]
  - id: noop
    label: noop
    on: github.pr.*
    do: [{ action: move, with: { to: dev } }]
  - id: winner
    label: winner
    on: github.pr.*
    do:
      - { action: move, with: { to: await, kind: review } }
      - { action: inbox, with: { title: "moved \${task.id}" } }
  - id: loser
    label: loser
    on: [github.pr.mergedChanged, harbormaster.task.*]
    do:
      - { action: move, with: { to: done } }
      - { action: message, with: { text: hi } }
  - id: broken-condition
    label: broken-condition
    on: github.pr.*
    if: facts.nope.x == 1
    do: [{ action: move, with: { to: done } }]
  - id: not-matching
    label: not-matching
    on: version-endpoint.*
    do: [{ action: move, with: { to: done } }]
`),
  ];

  it("one move per task (first legal, non-no-op rule in list order wins); every other action runs; broken conditions warn", async () => {
    const backlog = task({ state: "backlog" });
    const ctx = context(files, [backlog]);
    const matched = await matchRules(
      [event(), event({ id: "e2", type: "harbormaster.task.stateChanged" })],
      [],
      ctx,
    );
    expect(matched.candidates.map((c) => c.rule.id)).toEqual([
      "illegal-first",
      "noop",
      "winner",
      "loser",
    ]);
    expect(matched.warnings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("Rule broken-condition (rules.yaml:"),
      }),
    ]);
    const plan = await planActions(matched.candidates, ctx);
    expect(
      plan.actions.map((a) => [a.candidate.rule.id, a.action, a.status]),
    ).toEqual([
      // backlog → awaiting is illegal: skipped, the next rule gets its turn.
      ["illegal-first", "move", "skipped"],
      ["noop", "move", "run"],
      ["winner", "move", "superseded"],
      ["winner", "inbox", "run"],
      ["loser", "move", "superseded"],
      ["loser", "message", "run"],
    ]);
    expect(plan.actions[3]?.with).toEqual({ title: "moved t1" });
    expect(plan.actions[2]?.detail).toBe("rule noop moves this task this tick");
  });

  it("an already-satisfied move is skipped, so a later rule's move wins", async () => {
    const ctx = context(
      [
        parse(`rules:
  - { id: noop, label: noop, on: github.pr.*, do: [{ action: move, with: { to: dev } }] }
  - id: deploy
    label: deploy
    on: github.pr.*
    do: [{ action: move, with: { to: await, kind: deploy, input: { stage: pre } } }]
`),
      ],
      [task({ state: "dev" })],
    );
    const matched = await matchRules([event()], [], ctx);
    const plan = await planActions(matched.candidates, ctx);
    expect(
      plan.actions.map((a) => [a.candidate.rule.id, a.status, a.detail]),
    ).toEqual([
      ["noop", "skipped", "already in dev"],
      ["deploy", "run", undefined],
    ]);
    expect(plan.actions[1]?.move?.awaiting).toEqual({
      kind: "deploy",
      stageId: "pre",
      stageLabel: "Preprod",
    });
  });

  it("events about unknown tasks are ignored; untargeted moves are skipped", async () => {
    const ctx = context(files, []);
    expect((await matchRules([event()], [], ctx)).candidates).toEqual([]);
    const unbound = await matchRules([event({ subject: undefined })], [], ctx);
    const plan = await planActions(unbound.candidates, ctx);
    expect(
      plan.actions.filter((a) => a.action === "move").map((a) => a.status),
    ).toEqual(["skipped", "skipped", "skipped", "skipped"]);
  });

  it("runs the JS escape hatch for conditions and actions (actions return built-in specs)", async () => {
    const jsFiles = [
      parse(`rules:
  - id: js
    label: js
    on: github.pr.*
    if: "js:./checks.mjs#isHotfix"
    do:
      - action: "js:./actions.mjs#custom"
        with: { label: "\${task.id}" }
`),
    ];
    const seen: unknown[] = [];
    const ctx = context(jsFiles, [task()], {
      "js:./checks.mjs#isHotfix": (vars) =>
        (vars as RuleVariables).task?.branch === "widget",
      "js:./actions.mjs#custom": (input) => {
        seen.push(input);
        return [
          { action: "inbox", with: { title: "from js" } },
          { action: "move", with: { to: "await", kind: "slack" } },
        ];
      },
    });
    const matched = await matchRules([event()], [], ctx);
    const plan = await planActions(matched.candidates, ctx);
    expect(plan.actions.map((a) => [a.source, a.action, a.status])).toEqual([
      ["js:./actions.mjs#custom", "inbox", "run"],
      ["js:./actions.mjs#custom", "move", "run"],
    ]);
    expect(seen[0]).toMatchObject({
      with: { label: "t1" },
      task: { id: "t1" },
    });

    const failing = context(jsFiles, [task()], {
      "js:./checks.mjs#isHotfix": () => "yes",
    });
    const result = await matchRules([event()], [], failing);
    expect(result.candidates).toEqual([]);
    expect(result.warnings[0]?.message).toContain("must return a boolean");
  });
});

describe("addon validation", () => {
  const good = {
    dirName: "jira",
    manifest: {
      name: "jira",
      version: "1.0.0",
      provides: {
        sources: ["jira"],
        awaitingKinds: [{ id: "jira-qa", label: "Jira QA" }],
      },
    },
    module: {
      default: { id: "jira", interval: 60_000, snapshot: async () => [] },
    },
    suggestedRules: "rules: []\n",
    problems: [],
  };

  it("loads a valid addon and lists its suggested rules without activating them", () => {
    const result = validateAddons(
      [good],
      new Set(["github"]),
      new Set(["review"]),
    );
    expect(result.problems).toEqual([]);
    expect(result.sources.map((s) => s.id)).toEqual(["jira"]);
    expect(result.infos[0]).toMatchObject({
      name: "jira",
      loaded: true,
      builtin: false,
      sources: [{ id: "jira", interval: 60_000 }],
      awaitingKinds: [{ id: "jira-qa", label: "Jira QA" }],
      suggestedRules: "rules: []\n",
    });
  });

  it("skips broken addons and addons that shadow a built-in id, without affecting the others", () => {
    const shadow = {
      ...good,
      dirName: "evil",
      manifest: {
        ...good.manifest,
        name: "evil",
        provides: { sources: ["github"] },
      },
      module: { default: { id: "github", snapshot: async () => [] } },
    };
    const broken = {
      dirName: "broken",
      problems: ["addon.json: Unexpected token"],
    };
    const noExport = {
      ...good,
      dirName: "empty",
      manifest: { ...good.manifest, name: "empty" },
      module: {},
    };
    const result = validateAddons(
      [shadow, broken, noExport, good],
      new Set(["github"]),
      new Set(["review"]),
    );
    expect(result.sources.map((s) => s.id)).toEqual(["jira"]);
    expect(result.infos.map((info) => [info.name, info.loaded])).toEqual([
      ["evil", false],
      ["broken", false],
      ["empty", false],
      ["jira", true],
    ]);
    expect(result.problems.join("\n")).toContain('source "github" shadows');
    expect(result.problems.join("\n")).toContain(
      'does not export source "jira"',
    );
  });
});
