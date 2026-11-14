// The agent-facing rules guide (`<stateDir>/rules/AGENTS.md`): it covers
// every built-in action and `with` field, every `task` field, the
// mandatory `label`, and its worked example is a valid rules file.

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalRulesFileAccess } from "../src/access/local-rules-file-access.js";
import type { RuleTaskView } from "../src/contracts/rules.js";
import { parseRuleFile } from "../src/engines/rules/rule-files.js";
import {
  RULES_GUIDE_EXAMPLE_YAML,
  RULES_GUIDE_HEADER,
  RULES_GUIDE_MARKDOWN,
  RULES_MANAGED_FILES,
  ruleActionNames,
} from "../src/engines/rules/rules-guide.js";
import { RULES_SCHEMA } from "../src/engines/rules/rules-schema.js";

/** Every `RuleTaskView` field (typecheck fails when one is added or removed). */
const TASK_FIELDS = {
  id: true,
  title: true,
  kind: true,
  state: true,
  awaiting: true,
  branch: true,
  repository: true,
  pr: true,
  parentTaskId: true,
  createdAt: true,
  stateChangedAt: true,
} satisfies Record<keyof RuleTaskView, true>;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("the rules guide", () => {
  it("starts with the managed header and covers actions, task fields and the required label", () => {
    expect(RULES_GUIDE_MARKDOWN.split("\n")[0]).toBe(RULES_GUIDE_HEADER);
    expect(RULES_GUIDE_HEADER).toBe(
      "<!-- Managed by Harbormaster: regenerated on every start. Do not edit; put your notes in rules.yaml comments. -->",
    );
    expect(ruleActionNames()).toEqual([
      "move",
      "inbox",
      "createTask",
      "message",
    ]);
    const definitions = RULES_SCHEMA.definitions as unknown as Record<
      string,
      { properties: Record<string, unknown> }
    >;
    for (const action of ruleActionNames()) {
      expect(RULES_GUIDE_MARKDOWN).toContain(`- \`${action}\`:`);
      for (const field of Object.keys(
        definitions[`${action}Input`]?.properties ?? {},
      )) {
        expect(RULES_GUIDE_MARKDOWN).toContain(`\`${field}\``);
      }
    }
    for (const field of Object.keys(TASK_FIELDS)) {
      expect(RULES_GUIDE_MARKDOWN).toContain(`\`task.${field}\``);
    }
    expect(RULES_GUIDE_MARKDOWN).toContain("**`label` is required**");
    for (const variable of ["event", "facts.github", "repo", "js:./"]) {
      expect(RULES_GUIDE_MARKDOWN).toContain(variable);
    }
    for (const command of [
      "harbormaster rules list",
      "harbormaster rules check",
      "--task",
      "--replay",
      "harbormaster events --rule",
    ]) {
      expect(RULES_GUIDE_MARKDOWN).toContain(command);
    }
    expect(RULES_MANAGED_FILES).toEqual({
      "AGENTS.md": RULES_GUIDE_MARKDOWN,
      "CLAUDE.md": "@AGENTS.md\n",
    });
  });

  it("ships a worked example that loads without problems", () => {
    expect(RULES_GUIDE_MARKDOWN).toContain(RULES_GUIDE_EXAMPLE_YAML);
    const parsed = parseRuleFile({
      file: "rules.yaml",
      path: "/rules/rules.yaml",
      text: RULES_GUIDE_EXAMPLE_YAML,
    });
    expect(parsed.problems).toEqual([]);
    expect(parsed.rules.map((rule) => rule.condition.kind)).toEqual([
      "cel",
      "cel",
    ]);
  });

  it("writeManaged overwrites stale files and leaves identical ones untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harbormaster-guide-"));
    roots.push(dir);
    const access = new LocalRulesFileAccess(dir);
    await writeFile(join(dir, "AGENTS.md"), "old notes\n");
    await access.writeManaged({ "AGENTS.md": "new\n", "CLAUDE.md": "c\n" });
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("new\n");
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe("c\n");
    const before = (await stat(join(dir, "AGENTS.md"))).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await access.writeManaged({ "AGENTS.md": "new\n" });
    expect((await stat(join(dir, "AGENTS.md"))).mtimeMs).toBe(before);
  });
});
