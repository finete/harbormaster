import { describe, expect, it } from "vitest";
import type { AuditEntry, Rule, RuleFile } from "../src/preload/api";
import {
  applyDraftPrefill,
  emptyDraft,
  emptyPrefs,
  parseWhere,
  planSubmit,
} from "../src/renderer/src/lib/new-task-draft";
import {
  activityEntries,
  DOT_CLASS,
  dayKey,
  doChipText,
  fileHeaderKind,
  fileHeaderSegments,
  fileHeaderText,
  groupByDay,
  lastFiredText,
  moveRuleSelection,
  onChips,
  outcomeDot,
  problemLine,
  RULES_EDIT_CHOICE_KEY,
  readRulesEditChoice,
  ruleDot,
  rulesEditRequest,
  rulesFolder,
  rulesPageState,
  triggeringEvent,
  withSummary,
  writeRulesEditChoice,
} from "../src/renderer/src/lib/rules-format";

const now = Date.parse("2026-11-14T12:00:00.000Z");

function rule(id: string, overrides: Partial<Rule> = {}): Rule {
  return {
    id,
    label: id,
    on: ["github.pr.*"],
    do: [{ action: "move", with: { to: "dev" } }],
    file: "rules.yaml",
    line: 1,
    condition: { kind: "always" },
    ...overrides,
  };
}

function file(overrides: Partial<RuleFile> = {}): RuleFile {
  return {
    file: "rules.yaml",
    path: "/state/rules/rules.yaml",
    rules: [rule("a"), rule("b")],
    problems: [],
    ...overrides,
  };
}

describe("file header strings (the four fixed strings)", () => {
  it("global, loaded", () => {
    const f = file();
    expect(fileHeaderKind(f)).toBe("global-loaded");
    expect(fileHeaderText(f, "")).toBe(
      "· 2 rules · applies to every repository without an override",
    );
  });

  it("global, not loaded: the consequence is bold", () => {
    const f = file({ rules: [], problems: ["rules.yaml:3: bad"] });
    expect(fileHeaderKind(f)).toBe("global-broken");
    expect(fileHeaderText(f, "")).toBe(
      "· not loaded · repositories without an override currently have no rules",
    );
    expect(fileHeaderSegments(f, "")).toEqual([
      { text: "· not loaded · " },
      {
        text: "repositories without an override currently have no rules",
        strong: true,
      },
    ]);
  });

  it("repository override, loaded: repo label bold", () => {
    const f = file({
      file: "repos/github.com/acme/web.yaml",
      repositoryId: "github.com/acme/web",
      rules: [rule("a")],
    });
    expect(fileHeaderKind(f)).toBe("repo-loaded");
    expect(fileHeaderText(f, "github.com/acme/web")).toBe(
      "github.com/acme/web · 1 rule · replaces the global list for this repository",
    );
    expect(fileHeaderSegments(f, "web")[0]).toEqual({
      text: "web",
      strong: true,
    });
  });

  it("repository override, not loaded", () => {
    const f = file({
      repositoryId: "github.com/acme/web",
      rules: [],
      problems: ["x"],
    });
    expect(fileHeaderKind(f)).toBe("repo-broken");
    expect(fileHeaderText(f, "acme/web")).toBe(
      "acme/web · not loaded · this repository currently has no rules at all",
    );
    expect(
      fileHeaderSegments(f, "acme/web").filter((segment) => segment.strong),
    ).toEqual([
      { text: "acme/web", strong: true },
      { text: "this repository currently has no rules at all", strong: true },
    ]);
  });
});

describe("problemLine", () => {
  it("reads core's file:line: message as line N · message", () => {
    expect(
      problemLine('rules.yaml:12: duplicate rule id "x"', "rules.yaml"),
    ).toBe('line 12 · duplicate rule id "x"');
  });
  it("drops a bare file prefix, keeps anything else verbatim", () => {
    expect(problemLine("rules.yaml: bad indentation", "rules.yaml")).toBe(
      "bad indentation",
    );
    expect(problemLine("something else", "rules.yaml")).toBe("something else");
  });
});

describe("row chips", () => {
  it("on collapses to +N beyond two globs", () => {
    expect(onChips(["a"])).toEqual({ shown: ["a"], more: 0 });
    expect(onChips(["a", "b"])).toEqual({ shown: ["a", "b"], more: 0 });
    expect(onChips(["a", "b", "c", "d"])).toEqual({
      shown: ["a", "b"],
      more: 2,
    });
  });

  it("do chip text", () => {
    expect(doChipText({ action: "move", with: { to: "dev" } })).toBe(
      "move → dev",
    );
    expect(doChipText({ action: "move", with: { to: "await" } })).toBe(
      "move → await:review",
    );
    expect(
      doChipText({ action: "move", with: { to: "await", kind: "deploy" } }),
    ).toBe("move → await:deploy");
    expect(doChipText({ action: "inbox", with: { title: "x" } })).toBe("inbox");
    expect(doChipText({ action: "createTask" })).toBe("createTask");
    expect(doChipText({ action: "message" })).toBe("message");
    expect(doChipText({ action: "js:./a.mjs#go" })).toBe("js:./a.mjs#go");
  });

  it("with summary flattens values", () => {
    expect(withSummary({ with: { to: "await", kind: "deploy" } })).toBe(
      "to: await · kind: deploy",
    );
    expect(withSummary({ with: { input: { stage: "prod" } } })).toBe(
      'input: {"stage":"prod"}',
    );
    expect(withSummary({})).toBe("");
  });
});

describe("dot mapping", () => {
  it("mint applied, amber stayed/superseded, red failed, grey otherwise", () => {
    expect(outcomeDot("applied")).toBe("ok");
    expect(outcomeDot("stayed")).toBe("needsYou");
    expect(outcomeDot("superseded")).toBe("needsYou");
    expect(outcomeDot("failed")).toBe("error");
    expect(outcomeDot("skipped")).toBe("none");
    expect(ruleDot(undefined)).toBe("none");
    expect(
      ruleDot({
        lastAt: "2026-11-14T11:00:00Z",
        lastOutcome: "failed",
        count: 1,
      }),
    ).toBe("error");
  });
  it("uses the status tokens only", () => {
    expect(DOT_CLASS).toEqual({
      ok: "bg-status-ok",
      needsYou: "bg-status-needsYou",
      error: "bg-status-error",
      none: "bg-muted-foreground/40",
    });
  });
});

describe("relative last fired", () => {
  it("never / just now / Nh ago", () => {
    expect(lastFiredText(undefined, now)).toBe("never");
    expect(
      lastFiredText(
        { lastAt: "2026-11-14T11:59:40Z", lastOutcome: "applied", count: 1 },
        now,
      ),
    ).toBe("just now");
    expect(
      lastFiredText(
        { lastAt: "2026-11-14T10:00:00Z", lastOutcome: "applied", count: 1 },
        now,
      ),
    ).toBe("2h ago");
  });
});

describe("page shape", () => {
  it("degenerate states", () => {
    expect(rulesPageState([])).toBe("no-files");
    expect(
      rulesPageState([file({ rules: [], problems: ["rules.yaml:1: x"] })]),
    ).toBe("only-broken");
    expect(
      rulesPageState([
        file(),
        file({ file: "repos/x.yaml", repositoryId: "x", problems: ["p"] }),
      ]),
    ).toBe("list");
  });
  it("rules folder from a file path", () => {
    expect(rulesFolder([file()])).toBe("/state/rules");
    expect(
      rulesFolder([
        file({ file: "repos/a/b.yaml", path: "/s/rules/repos/a/b.yaml" }),
      ]),
    ).toBe("/s/rules");
    expect(rulesFolder([file({ path: "" })])).toBeUndefined();
  });
  it("arrow selection", () => {
    expect(moveRuleSelection(["a", "b", "c"], null, 1)).toBe("a");
    expect(moveRuleSelection(["a", "b", "c"], null, -1)).toBe("c");
    expect(moveRuleSelection(["a", "b", "c"], "b", 1)).toBe("c");
    expect(moveRuleSelection(["a", "b", "c"], "c", 1)).toBe("c");
    expect(moveRuleSelection([], null, 1)).toBeNull();
  });
});

describe("activity", () => {
  const event: AuditEntry = {
    kind: "event",
    at: "2026-11-13T09:00:00.000Z",
    event: {
      specversion: "1.0",
      id: "e1",
      source: "github",
      type: "github.pr.stateChanged",
      subject: "task/t1",
      time: "2026-11-13T09:00:00.000Z",
      data: { from: "OPEN", to: "MERGED" },
    },
  };
  const action: AuditEntry = {
    kind: "action",
    at: "2026-11-13T09:00:01.000Z",
    taskId: "t1",
    ruleId: "pr-merged",
    file: "rules.yaml",
    line: 3,
    eventId: "e1",
    eventType: "github.pr.stateChanged",
    action: "move",
    with: { to: "done" },
    outcome: "applied",
  };
  const other: AuditEntry = {
    ...action,
    at: "2026-11-14T08:00:00.000Z",
    ruleId: "other",
    taskId: "t2",
    outcome: "failed",
  };
  const warning: AuditEntry = {
    kind: "warning",
    at: "2026-11-14T09:00:00.000Z",
    message: "condition failed",
    ruleId: "pr-merged",
    file: "rules.yaml",
  };
  const all = [event, action, other, warning];

  it("actions + warnings by default, newest first; events on request", () => {
    expect(activityEntries(all, {}, false)).toEqual([warning, other, action]);
    expect(activityEntries(all, {}, true)).toEqual([
      warning,
      other,
      action,
      event,
    ]);
  });
  it("filters by rule, task and outcome", () => {
    expect(
      activityEntries(
        all,
        { rule: { file: "rules.yaml", ruleId: "pr-merged" } },
        true,
      ),
    ).toEqual([warning, action]);
    expect(
      activityEntries(
        all,
        { rule: { file: "repos/x.yaml", ruleId: "pr-merged" } },
        false,
      ),
    ).toEqual([]);
    expect(activityEntries(all, { taskId: "t1" }, true)).toEqual([
      action,
      event,
    ]);
    expect(activityEntries(all, { outcome: "failed" }, true)).toEqual([other]);
  });
  it("finds the triggering event by id", () => {
    expect(triggeringEvent(action as never, all)).toBe(event);
    expect(
      triggeringEvent({ ...(action as never), eventId: "nope" }, all),
    ).toBeUndefined();
  });
  it("groups by local day keeping order", () => {
    const groups = groupByDay(activityEntries(all, {}, false));
    expect(groups.map((group) => group.day)).toEqual([
      dayKey(warning.at),
      ...(dayKey(other.at) === dayKey(warning.at) ? [] : [dayKey(other.at)]),
      ...(dayKey(action.at) === dayKey(other.at) ? [] : [dayKey(action.at)]),
    ]);
  });
});

describe("the Edit split button", () => {
  it("prefills the composer for Edit in chat: the rules folder, a title and the prompt", () => {
    const request = rulesEditRequest("/Users/me/.harbormaster/rules");
    expect(request).toEqual({
      mode: "chat",
      where: "folder:/Users/me/.harbormaster/rules",
      title: "Edit rules",
      prompt:
        "Edit my Harbormaster rules in /Users/me/.harbormaster/rules/rules.yaml (and repos/*.yaml). Read AGENTS.md in this folder first; it documents the rules language. After editing, validate with `harbormaster rules list` and `harbormaster rules check`.",
    });
    expect(parseWhere(request.where)).toEqual({
      kind: "folder",
      path: "/Users/me/.harbormaster/rules",
    });
  });

  it("maps the request onto an empty draft in Chat mode (from any sticky mode), never onto a started one", () => {
    const folder = "/Users/me/.harbormaster/rules";
    const request = rulesEditRequest(folder);
    for (const mode of ["task", "review", "chat"] as const) {
      const draft = applyDraftPrefill(
        emptyDraft(null, {
          ...emptyPrefs(),
          mode,
          where: "repo:github.com/a/b",
        }),
        request,
      );
      expect(draft).toMatchObject({
        mode: "chat",
        where: `folder:${folder}`,
        title: "Edit rules",
        prompt: request.prompt,
        baseRef: null,
      });
      // Submitting (the user's call) creates a folder chat in the rules dir.
      expect(planSubmit(draft, "start", null)).toEqual({
        command: "createTask",
        input: expect.objectContaining({
          title: "Edit rules",
          folderPath: folder,
          start: true,
        }),
      });
    }
    const started = { ...emptyDraft(), prompt: "my own work" };
    expect(applyDraftPrefill(started, request)).toBe(started);
    // Without a mode, a prompt still never lands in Review mode.
    expect(
      applyDraftPrefill(emptyDraft(null, { ...emptyPrefs(), mode: "review" }), {
        prompt: "x",
      }).mode,
    ).toBe("task");
  });

  it("remembers the last choice, defaulting to Edit in chat", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    };
    expect(readRulesEditChoice(storage)).toBe("chat");
    writeRulesEditChoice(storage, "app");
    expect(map.get(RULES_EDIT_CHOICE_KEY)).toBe("app");
    expect(readRulesEditChoice(storage)).toBe("app");
    writeRulesEditChoice(storage, "chat");
    expect(readRulesEditChoice(storage)).toBe("chat");
    map.set(RULES_EDIT_CHOICE_KEY, "garbage");
    expect(readRulesEditChoice(storage)).toBe("chat");
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readRulesEditChoice(broken)).toBe("chat");
    expect(() => writeRulesEditChoice(broken, "app")).not.toThrow();
  });
});
