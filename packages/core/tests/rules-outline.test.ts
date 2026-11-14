// The structure-only CEL outline (engines/rules/outline.ts) and the rule
// condition view parseRuleFile computes from it (docs/rules-page.md
// decision 5): ALL / ANY-OF groups split by the parser, leaves that are
// verbatim source slices (whitespace collapsed), never a re-print.

import { describe, expect, it } from "vitest";
import type { CelOutline } from "../src/contracts/rules.js";
import { DEFAULT_RULES_YAML } from "../src/engines/rules/default-rules.js";
import { outlineCel, ruleConditionView } from "../src/engines/rules/outline.js";
import { parseRuleFile } from "../src/engines/rules/rule-files.js";

const all = (...items: Array<CelOutline | string>): CelOutline => ({
  kind: "all",
  items: items.map(node),
});
const any = (...items: Array<CelOutline | string>): CelOutline => ({
  kind: "any",
  items: items.map(node),
});
const node = (item: CelOutline | string): CelOutline =>
  typeof item === "string" ? { kind: "leaf", text: item } : item;

/** Every leaf's text, depth first. */
function leaves(outline: CelOutline): string[] {
  return outline.kind === "leaf"
    ? [outline.text]
    : outline.items.flatMap(leaves);
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** Each leaf is a slice of the (whitespace-collapsed) source, in source order. */
function expectVerbatimLeaves(source: string, outline: CelOutline): void {
  const flat = collapse(source);
  let from = 0;
  for (const text of leaves(outline)) {
    const at = flat.indexOf(text, from);
    expect(
      at,
      `leaf ${JSON.stringify(text)} is a slice of the source`,
    ).toBeGreaterThanOrEqual(0);
    from = at + text.length;
  }
}

describe("outlineCel", () => {
  const cases: Array<[string, string, CelOutline]> = [
    [
      "a single comparison is one leaf",
      'task.state == "dev"',
      node('task.state == "dev"'),
    ],
    [
      "an && chain is flattened into one ALL",
      "a && b && c",
      all("a", "b", "c"),
    ],
    [
      "an || chain is flattened into one ANY",
      "a || b || c",
      any("a", "b", "c"),
    ],
    [
      "a parenthesised || inside an && is a nested ANY",
      "a && (b || c) && d",
      all("a", any("b", "c"), "d"),
    ],
    [
      "&& binds tighter than || without parentheses",
      "a && b || c && d",
      any(all("a", "b"), all("c", "d")),
    ],
    [
      "nested groups three deep",
      "a || (b && (c || (d && e)))",
      any("a", all("b", any("c", all("d", "e")))),
    ],
    [
      "a parenthesised same-operator group stays its own group",
      "(a && b) && c",
      all(all("a", "b"), "c"),
    ],
    [
      "parentheses around single operands do not form groups",
      "(a) && (b) && c",
      all("a", "b", "c"),
    ],
    [
      "wrapping parentheses around the whole expression are dropped",
      "((a || b))",
      any("a", "b"),
    ],
    [
      "leaves keep their own parentheses (ranges widened to balance)",
      "(a + b) * c == 1 && !(x || y) && (p).q",
      all("(a + b) * c == 1", "!(x || y)", "(p).q"),
    ],
    [
      "calls, macros and ternaries are leaves",
      'size(xs) > 0 && xs.exists(x, x == "a && b") || (p ? q : r)',
      any(all("size(xs) > 0", 'xs.exists(x, x == "a && b")'), "p ? q : r"),
    ],
    [
      "parentheses inside string literals are not counted",
      'a == ")(" && (b || c == "(")',
      all('a == ")("', any("b", 'c == "("')),
    ],
    [
      "whitespace is collapsed outside strings, kept inside",
      'a  ==\n  "x  y"\n  &&\tb',
      all('a == "x  y"', "b"),
    ],
    [
      "parentheses inside comments are not counted",
      "a && // why (\n (b || c)",
      all("a", any("b", "c")),
    ],
    [
      "optional chaining is verbatim",
      'facts["v"].?stageId.orValue("") == task.awaiting.stageId && x',
      all('facts["v"].?stageId.orValue("") == task.awaiting.stageId', "x"),
    ],
  ];

  it.each(cases)("%s", (_name, source, expected) => {
    const outline = outlineCel(source);
    expect(outline).toEqual(expected);
    // Verbatim: ignoring whitespace, every leaf is a slice of the source, in order.
    const bare = (text: string) => text.replace(/\s+/g, "");
    let from = 0;
    for (const text of leaves(outline)) {
      const at = bare(source).indexOf(bare(text), from);
      expect(at).toBeGreaterThanOrEqual(0);
      from = at + bare(text).length;
    }
  });

  it("throws the parser's error for invalid CEL", () => {
    expect(() => outlineCel("task.state ==")).toThrow();
  });
});

describe("ruleConditionView", () => {
  it("maps absent, js:, valid and invalid conditions", () => {
    expect(ruleConditionView(undefined)).toEqual({ kind: "always" });
    expect(ruleConditionView("js:./checks.mjs#isScratch")).toEqual({
      kind: "js",
      ref: "js:./checks.mjs#isScratch",
    });
    expect(ruleConditionView("a || b")).toEqual({
      kind: "cel",
      source: "a || b",
      outline: any("a", "b"),
    });
    const invalid = ruleConditionView("a && (b");
    expect(invalid).toMatchObject({ kind: "cel-invalid", source: "a && (b" });
    expect(invalid.kind === "cel-invalid" && invalid.error).toMatch(/\S/);
    expect(invalid.kind === "cel-invalid" && invalid.error).not.toContain("\n");
  });

  it("parseRuleFile computes each rule's condition", () => {
    const file = parseRuleFile({
      file: "rules.yaml",
      path: "/state/rules/rules.yaml",
      text: `rules:
  - id: cel
    label: CEL
    on: a
    if: a && (b || c)
    do: [{ action: move, with: { to: dev } }]
  - id: js
    label: JS
    on: a
    if: "js:./checks.mjs#fn"
    do: [{ action: move, with: { to: dev } }]
  - id: always
    label: Always
    on: a
    do: [{ action: move, with: { to: dev } }]
`,
    });
    expect(file.problems).toEqual([]);
    expect(file.rules.map((rule) => rule.condition)).toEqual([
      {
        kind: "cel",
        source: "a && (b || c)",
        outline: all("a", any("b", "c")),
      },
      { kind: "js", ref: "js:./checks.mjs#fn" },
      { kind: "always" },
    ]);
  });

  it("an unparsable condition is cel-invalid (and the file reports it)", () => {
    const file = parseRuleFile({
      file: "rules.yaml",
      path: "/state/rules/rules.yaml",
      text: "rules:\n  - id: x\n    label: X\n    on: a\n    if: task.state ==\n    do: [{ action: move, with: { to: dev } }]\n",
    });
    expect(file.rules).toEqual([]);
    expect(file.problems).toEqual([
      expect.stringMatching(
        /^rules\.yaml:2: rule "x" has an invalid condition: \S/,
      ),
    ]);
  });
});

describe("the shipped default rules", () => {
  const expected: Record<string, CelOutline | undefined> = {
    "pr-merged-enter-deploy": all(
      "task.pr != null",
      'task.pr.role == "author"',
      '"state" in facts.github',
      'facts.github.state == "merged"',
      any(
        'task.state == "dev"',
        all('task.state == "awaiting"', 'task.awaiting.kind == "review"'),
      ),
    ),
    "review-changes-requested": all(
      'task.state == "awaiting"',
      'task.awaiting.kind == "review"',
      "task.pr != null",
      'task.pr.role == "author"',
      '"state" in facts.github',
      'facts.github.state != "merged"',
      any(
        'facts.github.state == "draft"',
        all(
          'facts.github.reviewDecision == "changes_requested"',
          "facts.github.changesRequestedOnHead != false",
        ),
        "facts.github.humanFeedbackOnHead == true",
      ),
    ),
    "review-requested-enter-review": all(
      'task.state == "dev"',
      "task.pr != null",
      'task.pr.role == "author"',
      '"state" in facts.github',
      'facts.github.state != "merged"',
      'facts.github.state != "draft"',
      '!(facts.github.reviewDecision == "changes_requested" && facts.github.changesRequestedOnHead != false)',
      "facts.github.humanFeedbackOnHead != true",
      any(
        "facts.github.reviewRequested == true",
        "facts.github.reviewSubmitted == true",
      ),
    ),
    "deploy-adopt-first-stage": all(
      'task.state == "awaiting"',
      'task.awaiting.kind == "deploy"',
      'task.awaiting.stageId == "__production"',
      "repo != null",
      "size(repo.deployment.stages) > 0",
    ),
    "deploy-advance-stage": all(
      'task.state == "awaiting"',
      'task.awaiting.kind == "deploy"',
      'facts["version-endpoint"].?stageId.orValue("") == task.awaiting.stageId',
      'facts["version-endpoint"].?next.orValue(null) != null',
    ),
    "deploy-land": all(
      'task.state == "awaiting"',
      'task.awaiting.kind == "deploy"',
      'facts["version-endpoint"].?stageId.orValue("") == task.awaiting.stageId',
      'facts["version-endpoint"].?land.orValue(false) == true',
    ),
    "reviewer-author-activity": all(
      "task.pr != null",
      'task.pr.role == "reviewer"',
      'task.state == "awaiting"',
    ),
    "reviewer-pr-closed": all(
      "task.pr != null",
      'task.pr.role == "reviewer"',
      "event.data.to == true",
    ),
    "review-requested-inbox": undefined,
  };

  const file = parseRuleFile({
    file: "rules.yaml",
    path: "/state/rules/rules.yaml",
    text: DEFAULT_RULES_YAML,
  });

  it("the table covers every shipped rule", () => {
    expect(file.problems).toEqual([]);
    expect(file.rules.map((rule) => rule.id).sort()).toEqual(
      Object.keys(expected).sort(),
    );
  });

  it.each(file.rules.map((rule) => [rule.id, rule] as const))(
    "%s outlines its condition from verbatim source slices",
    (id, rule) => {
      const outline = expected[id];
      if (outline === undefined) {
        expect(rule.if).toBeUndefined();
        expect(rule.condition).toEqual({ kind: "always" });
        return;
      }
      expect(rule.if).toBeDefined();
      expect(rule.condition).toEqual({
        kind: "cel",
        source: rule.if,
        outline,
      });
      expectVerbatimLeaves(rule.if ?? "", outline);
    },
  );
});
